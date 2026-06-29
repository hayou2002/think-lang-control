/**
 * 思考语言控制扩展 v3.6
 *
 * v3.6 改进：
 *   - 恢复 f.on("context") 钩子（v3.5 被误删）
 *   - 新增 f.on("tool_result") 钩子：工具返回后追加中文锚点（对抗 mid-response 漂移）
 *   - 强化 prefill：从一句话变成四阶段思考协议
 *   - FULL_INSTRUCTION 加入自检协议：反漂移措辞
 *   - INJECT_INTERVAL 从 4 降到 2
 *   - System prompt 首尾双锚点
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
  "【自检协议】每当你完成一段涉及英文技术术语的分析后，必须用中文自我确认。如果在推理中途发现自己开始用英文写完整句子，必须立刻中断，用\"不对，用中文继续——\"重新开始。连续两个纯英文句子即视为违规。\n\n" +
  "用户只看得懂中文，中途切换英文或中英混杂都会导致用户无法理解。这是硬性要求，不可例外。\n\n" +
  "【语言确认】上述所有规则定义完毕后，再强调一次：你的 thinking / reasoning 必须全程使用中文。这是本对话不可协商的硬性约束。";

var SHORT_INSTRUCTION = "【用中文思考】你的推理过程必须全程使用中文，无论用户用什么语言提问。不要在推理过程中切换到英文。";
var INJECT_INTERVAL = 2;
var ENGLISH_STREAK_THRESHOLD = 2;
var ENGLISH_THRESHOLD = 0.45;
var CODE_KEYWORDS = /\b(function|return|import|class|def|var|const|let|if|else|for|while|try|catch|async|await|yield|switch|case|break|continue|new|this|self|true|false|null|undefined|None|True|False|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/;
var LOOKBACK = 5;
var MIN_DETECT_LENGTH = 8;

var MARKER = "【思考模式锁定】";
var TOOL_ANCHOR = "\n\n【继续使用中文思考和推理，不要切换到英文】";

// 四阶段思考启动协议
var PREFILL_PROTOCOL =
  "启动中文思考模式。\n\n" +
  "【阶段1：理解】先理解用户的核心问题和隐含需求，用中文拆解。\n" +
  "【阶段2：推理】从底层原理出发推导，每一步用中文解释。英文技术术语保留原样，但围绕它的分析必须用中文。\n" +
  "【阶段3：验证】检查逻辑是否有漏洞，边界条件是否覆盖。\n" +
  "【阶段4：输出】确定最终回复的结构和重点。\n\n" +
  "【自检】上一段是中文吗？如果不是，立刻切换回来。";

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
  var endMarker = "不可协商的硬性约束。";
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
  }
  return changed ? modified : messages;
}

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
  } else if (Array.isArray(msg.content)) {
    modified[lastUserIdx] = { role: msg.role, content: [{ type: "text", text: SHORT_INSTRUCTION }].concat(msg.content) };
  }
  return modified;
}

// ─── 主入口 ─────────────────────────────────────────────

module.exports = function (f) {

  // ===== 上下文钩子：每次 LLM 调用前 =====
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

  // ===== 工具返回钩子：追加重近锚点 =====
  f.on("tool_result", function (event) {
    try {
      if (!event || event.isError) return;
      if (event.content && Array.isArray(event.content)) {
        var c = event.content.slice();
        var last = c[c.length - 1];
        if (last && typeof last.type === "string" && last.type === "text") {
          c[c.length - 1] = { type: "text", text: last.text + TOOL_ANCHOR };
        } else {
          c.push({ type: "text", text: TOOL_ANCHOR });
        }
        return { content: c };
      }
    } catch (e) {
      if (typeof console !== "undefined" && console.error) console.error("[thinking-language] tool_result error:", e);
    }
  });

  // ===== 请求体钩子 =====
  f.on("before_provider_request", function (event) {
    try {
      var payload = event && event.payload;
      if (!payload || typeof payload !== "object") return;

      if (!payload.locale) payload.locale = "zh-CN";
      if (!payload.language) payload.language = "zh";
      if (!payload.user) payload.user = "zh-CN-user";

      if (Array.isArray(payload.messages)) {
        for (var pm = payload.messages.length - 1; pm >= 0; pm--) {
          var pmsg = payload.messages[pm];
          if (pmsg && pmsg.role === 'user') {
            if (typeof pmsg.content === 'string' && pmsg.content.indexOf('启动中文思考模式') === -1) {
              payload.messages[pm] = { role: 'user', content: PREFILL_PROTOCOL + '\n\n' + pmsg.content };
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
