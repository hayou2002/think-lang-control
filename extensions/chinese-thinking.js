/**
 * 思考语言控制扩展 v3.1
 *
 * v3.1 改进：
 *   - 动态 prefill：根据用户消息语言/关键词生成中文 prefill
 *   - 翻译兜底改为结构化摘要（放弃效果差的单词替换）
 *   - Prefill 清理同时覆盖字符串和数组格式
 */

// ─── 配置 ─────────────────────────────────────────────────

var FULL_INSTRUCTION =
  "【思考模式锁定】你的推理过程必须全程使用中文。用中文进行所有内部推理、分析、规划和内心独白。\n\n" +
  "特别地，任何形式的推理内容（包括但不限于 reasoning_content、thinking、thinking block、chain_of_thought 等）都必须使用中文。\n\n" +
  "可保留英文的技术原语（仅原样保留，对它们的分析和解释仍用中文）：\n" +
  "• 代码标识符：变量名、函数名、类名、模块名、包名\n" +
  "• 查询与表达式：数据库查询语句、正则表达式、路径表达式\n" +
  "• 命令与路径：命令行指令、文件路径、网址链接\n" +
  "• 配置键名：配置文件键名、环境变量名、键值对\n" +
  "• 协议与格式：网络协议方法与状态码、端口号、编码格式\n" +
  "• 专有名称：产品名、服务名、库名、框架名\n" +
  "• 模型概念：嵌入向量、注意力机制、采样参数、分词器\n\n" +
  "遇到英文技术术语时，术语本身可保留英文原样，但围绕它的分析和解释必须用中文。禁止在分析过程中切换到完整的英文句子。\n\n" +
  "用户只看得懂中文，中途切换英文或中英混杂都会导致用户无法理解。这是硬性要求，不可例外。";

var SHORT_INSTRUCTION = "【用中文思考】你的推理过程必须全程使用中文，无论用户用什么语言提问。不要在推理过程中切换到英文。";
var INJECT_INTERVAL = 4;
var ENGLISH_STREAK_THRESHOLD = 2;
var ENGLISH_THRESHOLD = 0.45;
var CODE_KEYWORDS = /\b(function|return|import|class|def|var|const|let|if|else|for|while|try|catch|async|await|yield|switch|case|break|continue|new|this|self|true|false|null|undefined|None|True|False|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/;
var LOOKBACK = 5;
var MIN_DETECT_LENGTH = 8;

var MARKER = "【思考模式锁定】";
var TAIL_MARKER = "【思考锚点】";

// ─── 英中术语表（用于动态 prefill） ───────────────────

// ─── 工具函数 ─────────────────────────────────────────────

function isUserRole(role) {
  if (!role || typeof role !== "string") return false;
  var r = role.toLowerCase();
  return r === "user" || r === "human" || r === "speaker" || r === "customer";
}

function isAssistantRole(role) {
  if (!role || typeof role !== "string") return false;
  return role.toLowerCase() === "assistant";
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractBlockText).join("");
  return "";
}

function extractBlockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (block.text) return block.text;
  if (block.content !== undefined) {
    if (typeof block.content === "string") return block.content;
    if (Array.isArray(block.content)) return block.content.map(function (c) { return typeof c === "string" ? c : (c.text || ""); }).join("");
  }
  return "";
}

function hasMarker(text, marker) {
  return typeof text === "string" && text.indexOf(marker) !== -1;
}

function isEnglishHeavy(text) {
  if (!text || typeof text !== "string") return false;
  var cleaned = text.replace(/https?:\/\/\S+/g, "").replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, "").replace(/\S+@\S+\.\S+/g, "");
  var total = cleaned.replace(/\s+/g, "").length;
  if (total < MIN_DETECT_LENGTH) return false;
  var letters = cleaned.match(/[a-zA-Z]/g);
  var ratio = (letters ? letters.length : 0) / total;
  return ratio > ENGLISH_THRESHOLD || CODE_KEYWORDS.test(cleaned);
}

function countRecentEnglish(messages, endIdx) {
  var start = Math.max(0, endIdx - LOOKBACK);
  var count = 0;
  for (var i = start; i < endIdx; i++) {
    if (messages[i] && isUserRole(messages[i].role) && isEnglishHeavy(extractText(messages[i].content))) count++;
  }
  return count;
}

function countUserMessages(messages) {
  var count = 0;
  for (var i = 0; i < messages.length; i++) {
    if (messages[i] && isUserRole(messages[i].role)) count++;
  }
  return count;
}

// ─── 清理函数 ─────────────────────────────────────────────

function stripShortInstruction(text) {
  var idx = text.indexOf(SHORT_INSTRUCTION);
  if (idx === -1) return text;
  return (text.substring(0, idx) + text.substring(idx + SHORT_INSTRUCTION.length)).trimStart();
}

function stripFullInstruction(text) {
  var idx = text.indexOf(MARKER);
  if (idx === -1) return text;
  var after = text.substring(idx);
  var endMarker = "不可例外。";
  var endIdx = after.indexOf(endMarker);
  if (endIdx !== -1) {
    var fullEnd = endIdx + endMarker.length;
    var remaining = after.substring(fullEnd);
    var trimmedBefore = text.substring(0, idx).trimEnd();
    var trimmedAfter = remaining.replace(/^\n+/, "");
    return trimmedBefore + (trimmedAfter ? "\n\n" + trimmedAfter : "");
  }
  var newline = after.indexOf("\n\n");
  if (newline !== -1) return text.substring(0, idx) + after.substring(newline + 2);
  return text.substring(0, idx).trimEnd();
}

function cleanAllInjections(messages) {
  var modified = messages.slice();
  var changed = false;
  for (var i = 0; i < modified.length; i++) {
    var msg = modified[i];
    if (!msg) continue;

    // system 全量指令
    if (typeof msg.role === "string" && msg.role.toLowerCase() === "system") {
      var text = extractText(msg.content);
      if (hasMarker(text, MARKER)) {
        changed = true;
        if (typeof msg.content === "string") {
          modified[i] = { content: stripFullInstruction(msg.content), role: msg.role };
          if (msg.name) modified[i].name = msg.name;
        } else if (Array.isArray(msg.content)) {
          var blocks = msg.content.slice();
          for (var k = 0; k < blocks.length; k++) {
            var bt = extractBlockText(blocks[k]);
            if (hasMarker(bt, MARKER)) {
              if (typeof blocks[k] === "string") blocks[k] = stripFullInstruction(blocks[k]);
              else if (blocks[k] && blocks[k].text) blocks[k] = { type: blocks[k].type, text: stripFullInstruction(blocks[k].text) };
            }
          }
          modified[i] = { content: blocks, role: msg.role };
          if (msg.name) modified[i].name = msg.name;
        }
      }
    }

    // 用户短指令
    if (isUserRole(msg.role)) {
      var utxt = extractText(msg.content);
      if (hasMarker(utxt, SHORT_INSTRUCTION)) {
        changed = true;
        if (typeof msg.content === "string") {
          modified[i] = { content: stripShortInstruction(msg.content), role: msg.role };
        } else if (Array.isArray(msg.content)) {
          var ublocks = msg.content.slice();
          for (var j = 0; j < ublocks.length; j++) {
            var ubt = extractBlockText(ublocks[j]);
            if (hasMarker(ubt, SHORT_INSTRUCTION)) {
              if (typeof ublocks[j] === "string") ublocks[j] = stripShortInstruction(ublocks[j]);
              else if (ublocks[j] && ublocks[j].text) ublocks[j] = { type: ublocks[j].type, text: stripShortInstruction(ublocks[j].text) };
            }
          }
          modified[i] = { content: ublocks, role: msg.role };
        }
      }
    }

    // 尾部锚点
    if (isUserRole(msg.role) || isAssistantRole(msg.role)) {
      var atxt = extractText(msg.content);
      if (hasMarker(atxt, TAIL_MARKER)) {
        changed = true;
        if (typeof msg.content === "string") {
          modified[i] = { content: msg.content.replace(/\n*🔒\s*【思考锚点】[^\n]*/, "").trimEnd(), role: msg.role };
        }
      }
    }

    // assistant prefill（同时检测字符串和数组格式的 content）
    if (isAssistantRole(msg.role)) {
      var aptxt = extractText(msg.content);
      if (hasMarker(aptxt, PREFILL_MARKER) || aptxt === DEFAULT_PREFILL) {
        changed = true;
        modified[i] = null;
      }
    }
  }
  return changed ? modified.filter(function(m){ return m !== null; }) : messages;
}

// ─── 后处理：结构化摘要（替代单词替换） ───────────────────

// ─── 注入函数 ─────────────────────────────────────────────

function prependInstruction(messages, instruction) {
  var modified = messages.slice();
  var sysIdx = -1;
  for (var i = 0; i < modified.length; i++) {
    if (modified[i] && typeof modified[i].role === "string" && modified[i].role.toLowerCase() === "system") { sysIdx = i; break; }
  }
  if (sysIdx >= 0) {
    var sysMsg = modified[sysIdx];
    if (hasMarker(extractText(sysMsg.content), MARKER)) return modified;
    if (typeof sysMsg.content === "string") {
      modified[sysIdx] = { role: sysMsg.role, content: instruction + "\n\n" + sysMsg.content };
      if (sysMsg.name) modified[sysIdx].name = sysMsg.name;
    } else if (Array.isArray(sysMsg.content)) {
      modified[sysIdx] = { role: sysMsg.role, content: [{ type: "text", text: instruction + "\n\n" }].concat(sysMsg.content) };
      if (sysMsg.name) modified[sysIdx].name = sysMsg.name;
    }
  } else {
    modified.unshift({ role: "system", content: instruction });
  }
  return modified;
}

function adaptiveShortInjection(messages) {
  var modified = messages.slice();
  var changed = false;
  var userCount = countUserMessages(messages);
  var lastUserIdx = -1;
  for (var i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && isUserRole(messages[i].role)) { lastUserIdx = i; break; }
  }
  if (lastUserIdx < 0) return messages;
  var lastUserText = extractText(messages[lastUserIdx].content);
  if (hasMarker(lastUserText, SHORT_INSTRUCTION)) return modified;
  var shouldInject = (userCount <= 1) || (userCount % INJECT_INTERVAL === 0) || (countRecentEnglish(messages, lastUserIdx) >= ENGLISH_STREAK_THRESHOLD);
  if (!shouldInject) return messages;
  var msg = messages[lastUserIdx];
  if (typeof msg.content === "string") {
    modified[lastUserIdx] = { role: msg.role, content: SHORT_INSTRUCTION + " " + msg.content };
    changed = true;
  } else if (Array.isArray(msg.content)) {
    modified[lastUserIdx] = { role: msg.role, content: [{ type: "text", text: SHORT_INSTRUCTION }].concat(msg.content) };
    changed = true;
  }
  return changed ? modified : messages;
}

/** 从英文文本中提取术语并返回中文 */
function extractAndTranslate(text) {
  if (!text || typeof text !== "string") return [];
  var lower = text.toLowerCase();
  var found = [];
  var keys = Object.keys(TERM_MAP);
  for (var i = 0; i < keys.length; i++) {
    if (lower.indexOf(keys[i]) !== -1 && found.indexOf(TERM_MAP[keys[i]]) === -1) {
      found.push(TERM_MAP[keys[i]]);
      if (found.length >= 5) break;
    }
  }
  return found;
}

/** 动态生成 assistant prefill */

// ─── 主入口 ─────────────────────────────────────────────

module.exports = function (f) {
  f.on("context", function (ctx, params) {
    try {
      var model = params && params.model;
      if (!model || !Array.isArray(ctx.messages)) return;
      var messages = ctx.messages;
      messages = cleanAllInjections(messages);
      messages = prependInstruction(messages, FULL_INSTRUCTION);
      messages = adaptiveShortInjection(messages);
      return { messages: messages };
    } catch (e) {
      if (typeof console !== "undefined" && console.error) console.error("[thinking-language] context error:", e);
    }
  });

  f.on("before_provider_request", function (event) {
    try {
      var payload = event && event.payload;
      if (!payload || typeof payload !== "object") return;

      // ===== 请求体参数：语言提示 =====
      if (!payload.locale) payload.locale = "zh-CN";
      if (!payload.language) payload.language = "zh";

      
      // ===== user 字段（用于路由和语言偏好推断） =====
      if (!payload.user) payload.user = "zh-CN-user";

      
      // ===== 语言预填：合并到最后一条用户消息中（不渲染为独立回复） =====
      var prefilled = false;
      if (Array.isArray(payload.messages)) {
        for (var pm = payload.messages.length - 1; pm >= 0; pm--) {
          var pmsg = payload.messages[pm];
          if (pmsg && pmsg.role === 'user') {
            if (typeof pmsg.content === 'string' && pmsg.content.indexOf('让我用中文') === -1) {
              var keywords = [];
              var userText = pmsg.content;
              // 提取英文关键词
              var termKeys = Object.keys(TERM_MAP);
              for (var tk = 0; tk < termKeys.length; tk++) {
                if (userText.toLowerCase().indexOf(termKeys[tk]) !== -1) {
                  keywords.push(termKeys[tk]);
                }
              }
              var prefillText;
              if (keywords.length > 0) {
                prefillText = '好的，让我来分析这个关于' + keywords.join('、') + '的问题。';
              } else {
                prefillText = '好的，让我用中文来分析这个问题。';
              }
              payload.messages[pm] = { role: 'user', content: prefillText + '\n\n' + pmsg.content };
              prefilled = true;
            }
            break;
          }
        }
      }
return payload;
    } catch (e) {
      if (typeof console !== "undefined" && console.error) console.error("[thinking-language] before_provider_request error:", e);
    }
  });
};
