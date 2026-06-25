# 思考语言控制 — Think in Chinese

强制所有大语言模型在 `reasoning_content` / `thinking` 中使用中文进行内部推理。

兼容 DeepSeek、GPT、Claude、Qwen 等所有支持 `reasoning_content` 或 `thinking` 输出的推理模型。

## 特点

- **零配置**：安装启用即生效，无需任何配置
- **通用兼容**：通过 Pi SDK extension 机制注入指令，对所有模型生效
- **轻量无感**：仅 2KB，微秒级注入，不影响模型调用性能
- **无损兼容**：不修改系统提示词、技能、插件和挂载文件

## 工作原理

插件通过 HanaAgent 的 `extensions/`（Pi SDK Extension）钩住 `context` 事件。在每次 LLM 调用前，向第一条用户消息注入中文思考指令，让模型从一开始就建立中文推理上下文。

```
模型调用前 → 核心扩展 → 本插件注入【思考语言要求】→ 发送 API 请求
```

## 安装

### 方式一：拖拽安装（推荐）

1. 在 [Releases](https://github.com/hayou2002/think-lang-control/releases) 下载 `思考语言控制-v1.0.0.zip`
2. 打开 HanaAgent → 设置 → 插件
3. 将 zip 文件拖入安装区

### 方式二：手动安装

将插件目录解压到 `~/.hanako/plugins/thinking-language/`，然后重启 HanaAgent。

## 使用

安装启用后，**新建对话**即可生效。模型的 `reasoning_content` / `thinking` 将自动切换为中文。

> 现有对话不受影响。如果需要在现有对话中生效，请新建对话。

## 构建

```bash
# 插件源码结构
think-lang-control/
├── manifest.json           # 插件声明（full-access）
├── extensions/
│   └── chinese-thinking.js # Pi SDK extension 工厂
└── README.md
```

仅需将 `manifest.json` 和 `extensions/` 目录打包为 zip，即可安装。

## 许可证

Apache License 2.0
