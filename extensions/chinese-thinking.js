/**
 * 思考语言控制扩展 v2.1
 *
 * v2.0 → v2.1 修复：
 * - [BUG] extractText 不读 tool_result 的 content 字段，导致工具返回的英文内容从未被检测到
 * - [BUG] isEnglishHeavy 不剥离 HTML 标签，GitHub 返回的 HTML 标签稀释英文占比
 * - [BUG] isEnglishHeavy 剥离了代码块/行内代码，但代码本身就是英文内容（变量名、关键字、注释），
 *         是语言引力的主要来源，不应剥离
 * - [增强] 指令文本更强力，明确提及 GitHub、代码文件等场景
 * - [增强] LOOKBACK 从 3 提升到 5，覆盖更长的上下文窗口
 * - [增强] 最短检测长度从 30 降到 10，小段代码也能触发检测
 *
 * 设计原理：
 * - 推理发生在对话末尾，指令离末尾越近，模型越不可能忽视
 * - 英文内容形成"语言引力"，周期性注入是对抗这种引力的唯一手段
 * - 工具返回结果（web_fetch/browser）是英文内容的主要来源，必须能正确识别
 */

// ─── 配置 ─────────────────────────────────────────────────

/** 思考语言指令 */
var INSTRUCTION =
  "【思考语言要求】你的 reasoning_content / thinking 过程必须100%使用中文。" +
  "用中文进行所有内部推理、分析、规划和内心独白。" +
  "即使你刚刚从英文网站（GitHub、Stack Overflow、技术文档等）抓取了大段英文内容，" +
  "即使对话中充满了英文代码、PR、Issue、README，推理过程仍然必须使用中文，" +
  "仅保留必要的英文术语和专有名词（如变量名、函数名、库名）。" +
  "用户只看得懂中文，如果你用英文推理，用户将完全无法理解。这是硬性要求，不可例外。";

/** 每隔多少条用户消息刷新一次指令 */
var REINFORCE_INTERVAL = 3;

/** 英文内容检测阈值：ASCII字母占非空白字符的比例 */
var ENGLISH_THRESHOLD = 0.5;

/** 向前检查最近多少条消息的英文含量 */
var LOOKBACK = 5;

/** 最短检测长度（字符数） */
var MIN_DETECT_LENGTH = 10;

// ─── 工具函数 ─────────────────────────────────────────────

var MARKER = "【思考语言要求】";

/**
 * 从消息 content 中提取纯文本
 * 兼容三种格式：
 *   1. 纯字符串 content
 *   2. content 数组中的 { type: "text", text: "..." }
 *   3. content 数组中的 { type: "tool_result", content: "..." } 或嵌套数组
 */
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractBlockText).join("");
  }
  return "";
}

function extractBlockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";

  // 优先读 text 字段（普通文本块）
  if (block.text) return block.text;

  // 处理 tool_result 等带 content 字段的块
  if (block.content !== undefined) {
    if (typeof block.content === "string") return block.content;
    if (Array.isArray(block.content)) {
      return block.content.map(function (c) {
        return typeof c === "string" ? c : (c.text || "");
      }).join("");
    }
  }

  return "";
}

/** 检查文本中是否已包含思考语言指令 */
function hasInstruction(text) {
  return typeof text === "string" && text.indexOf(MARKER) !== -1;
}

/**
 * 从文本中剥离思考语言指令，保留用户原始消息
 */
function stripInstruction(text) {
  var idx = text.indexOf(MARKER);
  if (idx === -1) return text;

  var after = text.substring(idx);
  var newline = after.indexOf("\n\n");
  if (newline === -1) return text.substring(0, idx).trimEnd();
  return text.substring(0, idx) + after.substring(newline + 2);
}

/**
 * 检测文本是否主要是英文
 * 只去除 URL 和 HTML 标签（它们不是语言内容）
 * 保留代码块和行内代码——变量名、关键字、注释全是英文，是语言引力的主要来源
 */
function isEnglishHeavy(text) {
  if (!text || typeof text !== "string") return false;
  var cleaned = text
    .replace(/https?:\/\/\S+/g, "")    // URL
    .replace(/<[^>]+>/g, "")             // HTML 标签
    .replace(/&[a-z]+;/gi, "");          // HTML 实体
  var total = cleaned.replace(/\s+/g, "").length;
  if (total < MIN_DETECT_LENGTH) return false;
  var letters = cleaned.match(/[a-zA-Z]/g);
  return (letters ? letters.length : 0) / total > ENGLISH_THRESHOLD;
}

/**
 * 检查最近的消息中是否包含英文内容
 * 同时检查用户消息和助手/工具消息
 */
function hasRecentEnglish(messages, endIdx) {
  var start = Math.max(0, endIdx - LOOKBACK);
  for (var i = start; i < endIdx; i++) {
    var msg = messages[i];
    if (!msg) continue;
    var text = extractText(msg.content);
    if (isEnglishHeavy(text)) return true;
  }
  return false;
}

/**
 * 从末尾往前数，距离上次指令注入经过了几条用户消息
 */
function messagesSinceInjection(messages) {
  var count = 0;
  for (var i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") {
      if (hasInstruction(extractText(messages[i].content))) return count;
      count++;
    }
  }
  return count;
}

// ─── 注入逻辑 ─────────────────────────────────────────────

/**
 * 将指令注入到指定消息开头
 * 如果消息中已有旧指令，先剥离再注入新的（避免重复堆叠）
 */
function applyInstruction(messages, idx, instruction) {
  var msg = messages[idx];
  var modified = messages.slice();

  if (typeof msg.content === "string") {
    var stripped = stripInstruction(msg.content);
    modified[idx] = {
      ...msg,
      content: instruction + "\n\n" + stripped,
    };
  } else if (Array.isArray(msg.content)) {
    var blocks = msg.content.slice();
    for (var j = 0; j < blocks.length; j++) {
      var block = blocks[j];
      var blockText = extractBlockText(block);
      if (hasInstruction(blockText)) {
        if (typeof block === "string") {
          blocks[j] = stripInstruction(block);
        } else {
          blocks[j] = { ...block, text: stripInstruction(blockText) };
        }
        break;
      }
    }
    modified[idx] = {
      ...msg,
      content: [{ type: "text", text: instruction }].concat(blocks),
    };
  }

  return modified;
}

// ─── 主入口 ─────────────────────────────────────────────

module.exports = function (f) {
  f.on("context", function (ctx, params) {
    var model = params && params.model;
    if (!model || !Array.isArray(ctx.messages)) return;

    var messages = ctx.messages;

    // 找到最后一条用户消息（推理的锚点）
    var lastIdx = -1;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === "user") {
        lastIdx = i;
        break;
      }
    }
    if (lastIdx < 0) return;

    var lastContent = extractText(messages[lastIdx].content);

    // ── 决策树 ──

    // 1. 最后一条消息没有指令 → 注入
    if (!hasInstruction(lastContent)) {
      return { messages: applyInstruction(messages, lastIdx, INSTRUCTION) };
    }

    // 2. 已有指令 → 判断是否需要刷新
    var gap = messagesSinceInjection(messages);
    var english = hasRecentEnglish(messages, lastIdx);

    if (gap >= REINFORCE_INTERVAL || english) {
      return { messages: applyInstruction(messages, lastIdx, INSTRUCTION) };
    }

    // 3. 不需要操作
    return undefined;
  });
};
