/**
 * 思考语言控制扩展
 *
 * 作用：在每次模型推理前，向第一条用户消息中注入中文思考指令，
 * 强制所有模型的 reasoning_content / thinking 使用中文。
 *
 * 兼容性：通过 f.on("context") 钩子工作，在所有核心扩展（provider 兼容、角色沉浸等）
 * 之后执行，不干扰现有流程。
 */

/** 注入的中文思考指令 */
var THINKING_INSTRUCTION =
  "【思考语言要求】你的 reasoning_content / thinking 过程必须使用中文。用中文进行所有内部推理、分析、规划和内心独白。";

/** 去重标记：检查消息中是否已包含该指令 */
function hasInstruction(text) {
  return typeof text === "string" && text.indexOf("【思考语言要求】") !== -1;
}

/**
 * 扩展工厂函数
 * 由 Hana 插件系统通过 import() 动态导入，兼容 CJS module.exports
 */
module.exports = function (f) {
  f.on("context", function (ctx, params) {
    var model = params && params.model;
    if (!model || !Array.isArray(ctx.messages)) return;

    var messages = ctx.messages;

    // 找到第一条用户消息
    var firstUserIdx = -1;
    for (var i = 0; i < messages.length; i++) {
      if (messages[i] && messages[i].role === "user") {
        firstUserIdx = i;
        break;
      }
    }
    if (firstUserIdx < 0) return;

    var firstUserMsg = messages[firstUserIdx];
    if (!firstUserMsg || !firstUserMsg.content) return;

    // 检查是否已注入过（防止重复）
    var contentStr =
      typeof firstUserMsg.content === "string"
        ? firstUserMsg.content
        : Array.isArray(firstUserMsg.content)
          ? firstUserMsg.content
              .map(function (b) {
                return typeof b === "string" ? b : b.text || "";
              })
              .join("")
          : "";

    if (hasInstruction(contentStr)) return;

    // 注入指令到第一条用户消息开头
    var modified = messages.slice();
    if (typeof firstUserMsg.content === "string") {
      modified[firstUserIdx] = {
        ...firstUserMsg,
        content: THINKING_INSTRUCTION + "\n\n" + firstUserMsg.content,
      };
    } else if (Array.isArray(firstUserMsg.content)) {
      modified[firstUserIdx] = {
        ...firstUserMsg,
        content: [{ type: "text", text: THINKING_INSTRUCTION }].concat(firstUserMsg.content),
      };
    } else {
      return;
    }

    return { messages: modified };
  });
};
