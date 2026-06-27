/**
 * 思考语言控制扩展 v2.6
 *
 * 分层注入策略：
 *   第 0 步：清理旧指令（修复 token 累积）
 *   第 0.5 步：英文 thinking 追加中文翻译（后处理兜底）
 *   第 1 步：每条用户消息注入短指令 "【用中文思考】"（持续 priming）
 *   第 2 步：system message 注入全量指令（首次 + 每 10 条刷新）
 *   第 3 步：尾部锚点（每次近因效应）
 */

// ─── 配置 ─────────────────────────────────────────────────

/** 全量指令：注入到 system message */
var INSTRUCTION =
  "【思考模式锁定】你的推理过程必须全程使用中文。用中文进行所有内部推理、分析、规划和内心独白。\n\n" +
  "可保留英文的技术原语（仅原样保留，对它们的分析和解释仍用中文）：\n" +
  "• 代码标识符：变量名、函数名、类名、模块名、包名\n" +
  "• 查询与表达式：数据库查询语句、正则表达式、路径表达式\n" +
  "• 命令与路径：命令行指令、文件路径、网址链接\n" +
  "• 配置键名：配置文件键名、环境变量名、键值对\n" +
  "• 协议与格式：网络协议方法与状态码、端口号、编码格式\n" +
  "• 专有名称：产品名、服务名、库名、框架名\n" +
  "• 模型概念：嵌入向量、注意力机制、采样参数、分词器\n\n" +
  "典型场景（包括但不限于）：\n" +
  "代码文件分析、工具返回结果处理、网页内容理解、数据库操作、命令行与脚本、" +
  "容器与编排、持续集成管道、接口规范定义、错误诊断与日志分析、数学与算法推导、" +
  "加密与安全验证、基础设施配置、版本控制操作。\n\n" +
  "用户只看得懂中文，中途切换英文或中英混杂都会导致用户无法理解。这是硬性要求，不可例外。";

/** 中指令：注入到每条用户消息（priming 用，比 "用中文思考" 更严格） */
var MEDIUM_INSTRUCTION = "【用中文思考】你的推理过程必须全程使用中文。即使遇到英文内容，也必须用中文推理，仅保留英文术语原样。";

/** 尾部锚点 */
var TAIL_ANCHOR = "🔒 【思考锚点】用中文继续推理，遇到英文内容时用中文分析，仅保留技术原语。";

/** system message 全量指令刷新间隔（条） */
var SYS_REFRESH_INTERVAL = 3;

/** 英文内容检测阈值 */
var ENGLISH_THRESHOLD = 0.5;
var CODE_KEYWORDS = /\b(function|return|import|class|def|var|const|let|if|else|for|while|try|catch|async|await|yield|switch|case|break|continue|new|this|self|true|false|null|undefined|None|True|False)\b/;
var LOOKBACK = 5;
var MIN_DETECT_LENGTH = 10;

// ─── 工具函数 ─────────────────────────────────────────────

var MARKER = "【思考模式锁定】";
var TAIL_MARKER = "【思考锚点】";

function isUserRole(role) {
  if (!role || typeof role !== "string") return false;
  var r = role.toLowerCase();
  return r === "user" || r === "human" || r === "speaker" || r === "customer";
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

function hasInstruction(text) { return typeof text === "string" && text.indexOf(MARKER) !== -1; }
function hasTailAnchor(text) { return typeof text === "string" && text.indexOf(TAIL_MARKER) !== -1; }
function hasMediumInstruction(text) { return typeof text === "string" && text.indexOf(MEDIUM_INSTRUCTION.substring(0, 10)) !== -1; }

function isEnglishHeavy(text) {
  if (!text || typeof text !== "string") return false;
  var cleaned = text.replace(/https?:\/\/\S+/g, "").replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, "");
  var total = cleaned.replace(/\s+/g, "").length;
  if (total < MIN_DETECT_LENGTH) return false;
  var letters = cleaned.match(/[a-zA-Z]/g);
  var ratio = (letters ? letters.length : 0) / total;
  if (ratio > ENGLISH_THRESHOLD) return true;
  if (/```[\s\S]*?```/.test(cleaned)) return true;
  if (CODE_KEYWORDS.test(cleaned)) return true;
  return false;
}

function hasRecentEnglish(messages, endIdx) {
  var start = Math.max(0, endIdx - LOOKBACK);
  for (var i = start; i < endIdx; i++) {
    if (messages[i] && isEnglishHeavy(extractText(messages[i].content))) return true;
  }
  return false;
}

// ─── 旧指令清理 ─────────────────────────────────────────

function stripInstruction(text) {
  var idx = text.indexOf(MARKER);
  if (idx === -1) return text;
  var after = text.substring(idx);
  var newline = after.indexOf("\n\n");
  if (newline !== -1) return text.substring(0, idx) + after.substring(newline + 2);
  var endMarker = "不可例外。";
  var endIdx = after.indexOf(endMarker);
  if (endIdx !== -1) return text.substring(0, idx).trimEnd() + after.substring(endIdx + endMarker.length);
  return text.substring(0, idx).trimEnd();
}

function cleanOldInstructions(messages) {
  var modified = messages.slice();
  var changed = false;
  for (var j = 0; j < modified.length; j++) {
    if (!modified[j] || !isUserRole(modified[j].role)) continue;
    var text = extractText(modified[j].content);
    if (!hasInstruction(text)) continue;
    changed = true;
    if (typeof modified[j].content === "string") {
      modified[j] = { ...modified[j], content: stripInstruction(modified[j].content) };
    } else if (Array.isArray(modified[j].content)) {
      var blocks = modified[j].content.slice();
      for (var k = 0; k < blocks.length; k++) {
        var bt = extractBlockText(blocks[k]);
        if (hasInstruction(bt)) {
          if (typeof blocks[k] === "string") blocks[k] = stripInstruction(blocks[k]);
          else if (blocks[k] && blocks[k].text) blocks[k] = { ...blocks[k], text: stripInstruction(blocks[k].text) };
        }
      }
      modified[j] = { ...modified[j], content: blocks };
    }
  }
  return changed ? modified : messages;
}

// ─── 后处理翻译 ─────────────────────────────────────────

var TRANSLATION_MAP = {
  "let me": "让我", "I need to": "需要", "I should": "应该",
  "the user is asking": "用户询问", "the user wants": "用户想要", "the user": "用户",
  "I will": "将会", "this is because": "这是因为", "the key difference": "关键区别",
  "the main issue": "主要问题", "the problem is": "问题在于",
  "first": "首先", "second": "其次", "finally": "最后", "in conclusion": "总之",
  "therefore": "因此", "however": "然而", "for example": "例如",
  "this means": "这意味着", "the answer is": "答案是", "the solution is": "解决方案是",
  "I think": "我认为", "it seems": "看起来", "note that": "注意",
};

function simpleTranslate(englishText) {
  if (!englishText || typeof englishText !== "string") return "";
  var excerpt = englishText.length > 200 ? englishText.substring(0, 200) + "..." : englishText.trim();
  var translated = excerpt;
  var entries = Object.entries(TRANSLATION_MAP);
  for (var i = 0; i < entries.length; i++) {
    var regex = new RegExp("\\b" + entries[i][0].replace(/[.*+?^${}()|[\]\\]/g, "\\\$&") + "\\b", "gi");
    translated = translated.replace(regex, entries[i][1]);
  }
  return translated === excerpt ? "此段推理涉及技术分析，模型正在分析问题并制定解决方案。" : translated;
}

function addChineseTranslation(messages) {
  var modified = messages.slice();
  var changed = false;
  for (var i = 0; i < modified.length; i++) {
    var msg = modified[i];
    if (!msg) continue;
    if (Array.isArray(msg.content)) {
      var blocks = msg.content.slice();
      var newBlocks = [];
      var blockChanged = false;
      for (var j = 0; j < blocks.length; j++) {
        var block = blocks[j];
        newBlocks.push(block);
        if (!block) continue;
        var thinkingText = null;
        if (block.type === "thinking" || block.type === "reasoning") thinkingText = block.thinking || block.text || "";
        else if (block.type === "redacted_thinking") thinkingText = block.thinking || "";
        if (thinkingText && typeof thinkingText === "string" && isEnglishHeavy(thinkingText)) {
          newBlocks.push({ type: "thinking", thinking: "【中文翻译】" + simpleTranslate(thinkingText) });
          blockChanged = true;
        }
      }
      if (blockChanged) { modified[i] = { ...msg, content: newBlocks }; changed = true; }
    }
    if (typeof msg.reasoning_content === "string" && isEnglishHeavy(msg.reasoning_content)) {
      modified[i] = { ...msg, reasoning_content: msg.reasoning_content + "\n\n【中文翻译】" + simpleTranslate(msg.reasoning_content) };
      changed = true;
    }
  }
  return changed ? modified : messages;
}

// ─── 注入函数 ─────────────────────────────────────────

function injectSystemMessage(messages, instruction) {
  var modified = messages.slice();
  var sysIdx = -1;
  for (var i = 0; i < modified.length; i++) {
    if (modified[i] && typeof modified[i].role === "string" && modified[i].role.toLowerCase() === "system") { sysIdx = i; break; }
  }
  if (sysIdx >= 0) {
    if (hasInstruction(extractText(modified[sysIdx].content))) return modified;
    var sysMsg = modified[sysIdx];
    if (typeof sysMsg.content === "string") modified[sysIdx] = { ...sysMsg, content: sysMsg.content + "\n\n" + instruction };
    else if (Array.isArray(sysMsg.content)) modified[sysIdx] = { ...sysMsg, content: sysMsg.content.concat([{ type: "text", text: "\n\n" + instruction }]) };
  } else {
    modified.unshift({ role: "system", content: instruction });
  }
  return modified;
}

function injectMediumInstructionToAll(messages) {
  var modified = messages.slice();
  var changed = false;
  for (var i = 0; i < modified.length; i++) {
    var msg = modified[i];
    if (!msg || !isUserRole(msg.role)) continue;
    var content = extractText(msg.content);
    // 只检查是否已有中指令，全量指令不影响中指令注入
    if (hasMediumInstruction(content)) continue;
    if (typeof msg.content === "string") {
      modified[i] = { ...msg, content: MEDIUM_INSTRUCTION + " " + msg.content };
      changed = true;
    } else if (Array.isArray(msg.content)) {
      modified[i] = { ...msg, content: [{ type: "text", text: MEDIUM_INSTRUCTION }].concat(msg.content) };
      changed = true;
    }
  }
  return changed ? modified : messages;
}

function applyTailAnchor(messages) {
  var lastIdx = messages.length - 1;
  if (lastIdx < 0) return messages;
  var lastMsg = messages[lastIdx];
  var lastText = extractText(lastMsg.content);
  var modified = messages.slice();
  if (hasTailAnchor(lastText)) {
    if (typeof lastMsg.content === "string") {
      modified[lastIdx] = { ...lastMsg, content: lastMsg.content.replace(/\n*🔒\s*【思考锚点】[^\n]*/, "").trimEnd() + "\n\n" + TAIL_ANCHOR };
    }
    return modified;
  }
  if (typeof lastMsg.content === "string") modified[lastIdx] = { ...lastMsg, content: lastMsg.content + "\n\n" + TAIL_ANCHOR };
  else if (Array.isArray(lastMsg.content)) modified[lastIdx] = { ...lastMsg, content: lastMsg.content.concat([{ type: "text", text: "\n\n" + TAIL_ANCHOR }]) };
  return modified;
}

function countUserMessages(messages) {
  var count = 0;
  for (var i = 0; i < messages.length; i++) {
    if (messages[i] && isUserRole(messages[i].role)) count++;
  }
  return count;
}

// ─── 主入口 ─────────────────────────────────────────────

module.exports = function (f) {
  f.on("context", function (ctx, params) {
    try {
      var model = params && params.model;
      if (!model || !Array.isArray(ctx.messages)) return;
      var messages = ctx.messages;

      // 第 0 步：清理旧全量指令
      messages = cleanOldInstructions(messages);

      // 第 0.5 步：英文 thinking 追加中文翻译
      messages = addChineseTranslation(messages);

      // 第 1 步：所有用户消息注入中指令（"你的推理过程必须全程使用中文..."）
      messages = injectMediumInstructionToAll(messages);

      // 第 2 步：system message 全量指令（首次 + 每 10 条刷新）
      var sysIdx = -1;
      for (var s = 0; s < messages.length; s++) {
        if (messages[s] && typeof messages[s].role === "string" && messages[s].role.toLowerCase() === "system") { sysIdx = s; break; }
      }
      var userCount = countUserMessages(messages);
      var needSysRefresh = sysIdx < 0 || !hasInstruction(extractText(messages[sysIdx].content)) || (userCount > 0 && userCount % SYS_REFRESH_INTERVAL === 0);
      if (needSysRefresh) messages = injectSystemMessage(messages, INSTRUCTION);

      // 第 3 步：尾部锚点
      var lastMsg = messages[messages.length - 1];
      if (!hasTailAnchor(extractText(lastMsg ? lastMsg.content : ""))) messages = applyTailAnchor(messages);

      return { messages: messages };
    } catch (e) {
      if (typeof console !== "undefined" && console.error) console.error("[thinking-language] context error:", e);
    }
  });
};
