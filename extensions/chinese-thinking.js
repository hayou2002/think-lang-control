/**
 * 思考语言控制扩展 v2.2
 *
 * v2.1 → v2.2 修复：
 * - [增强] 新增"语言块检测"：即使整体英文比例被中文注释拉低，
 *         只要存在 3 个以上英文标识符（变量名、函数名、关键字），仍触发注入
 * - [修复] applyInstruction 数组格式剥离时，剥离后未用更新的 block 继续检查
 * - [增强] messagesSinceInjection 兼容 role 为 "human" 等变体格式
 *
 * 设计原理：
 * - 推理发生在对话末尾，指令离末尾越近，模型越不可能忽视
 * - 英文内容形成"语言引力"，周期性注入是对抗这种引力的唯一手段
 * - 代码文件即使有大量中文注释，其中的英文标识符仍然是引力来源
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

/** 语言块检测：至少多少个英文标识符才触发 */
var CODE_WORD_THRESHOLD = 3;

/** 英文标识符最小长度（字符数） */
var CODE_WORD_MIN_LEN = 3;

/** 向前检查最近多少条消息的英文含量 */
var LOOKBACK = 5;

/** 最短检测长度（字符数） */
var MIN_DETECT_LENGTH = 10;

// ─── 工具函数 ─────────────────────────────────────────────

var MARKER = "【思考语言要求】";

/** 判断是否为用户角色（兼容多种格式） */
function isUserRole(role) {
  return role === "user" || role === "human";
}

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

  if (block.text) return block.text;

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
 *
 * 两级检测：
 *   1. 整体比例：ASCII 字母占非空白字符 > 50%
 *   2. 语言块：存在 3+ 个英文标识符（变量名、函数名、关键字），
 *      即使中文注释把整体比例拉低也能检测到
 */
function isEnglishHeavy(text) {
  if (!text || typeof text !== "string") return false;
  var cleaned = text
    .replace(/https?:\/\/\S+/g, "")    // URL
    .replace(/<[^>]+>/g, "")            // HTML 标签
    .replace(/&[a-z]+;/gi, "");         // HTML 实体
  var total = cleaned.replace(/\s+/g, "").length;
  if (total < MIN_DETECT_LENGTH) return false;

  // ── 检测 1：整体英文比例 ──
  var letters = cleaned.match(/[a-zA-Z]/g);
  var ratio = (letters ? letters.length : 0) / total;
  if (ratio > ENGLISH_THRESHOLD) return true;

  // ── 检测 2：语言块（代码标识符）──
  // 匹配英文标识符：以字母或下划线开头，后跟字母/数字/下划线，长度 >= 3
  // 排除纯数字和下划线开头的内部变量
  var identifiers = cleaned.match(/\b[a-zA-Z][a-zA-Z0-9_]{2,}\b/g);
  if (identifiers && identifiers.length >= CODE_WORD_THRESHOLD) return true;

  return false;
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
    if (messages[i] && isUserRole(messages[i].role)) {
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
    var hasOldInstruction = false;

    // 先检查是否有旧指令
    for (var j = 0; j < blocks.length; j++) {
      if (hasInstruction(extractBlockText(blocks[j]))) {
        hasOldInstruction = true;
        break;
      }
    }

    // 剥离旧指令
    if (hasOldInstruction) {
      for (var k = 0; k < blocks.length; k++) {
        var blockText = extractBlockText(blocks[k]);
        if (hasInstruction(blockText)) {
          if (typeof blocks[k] === "string") {
            blocks[k] = stripInstruction(blocks[k]);
          } else if (blocks[k] && blocks[k].text) {
            blocks[k] = { ...blocks[k], text: stripInstruction(blocks[k].text) };
          }
        }
      }
    }

    // 在开头插入新指令
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
      if (messages[i] && isUserRole(messages[i].role)) {
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
