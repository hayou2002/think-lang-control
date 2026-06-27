# 思考语言控制 — Think in Chinese

强制所有大语言模型在 `reasoning_content` / `thinking` 中使用中文进行内部推理。

兼容 DeepSeek、GPT、Claude、Qwen 等所有支持 `reasoning_content` 或 `thinking` 输出的推理模型。

## 特点

- **零配置**：安装启用即生效，无需任何配置
- **通用兼容**：通过 Pi SDK extension 机制注入指令，对所有模型生效
- **轻量无感**：微秒级注入，不影响模型调用性能
- **老对话适用**：安装后当前对话和新对话均自动生效，无需迁移
- **分层注入**：每条消息短指令 + system 全量指令 + 尾部锚点，三层保障
- **后处理翻译**：英文 thinking 自动追加中文翻译块
- **旧指令清理**：自动清理历史旧指令，防止 token 累积
- **英文感知**：自动检测上下文中的英文内容，实时加固中文推理指令

## 工作原理

插件通过 HanaAgent 的 `extensions/`（Pi SDK Extension）钩住 `context` 事件。在每次 LLM 调用前执行分层处理：

```
第 0 步：清理旧指令（修复 token 累积）
第 0.5 步：英文 thinking 追加中文翻译（后处理兜底）
第 1 步：每条用户消息注入中指令
第 2 步：system message 注入全量指令（每 3 条刷新）
第 3 步：尾部锚点
```

### 分层注入策略（v2.7.1）

| 层级 | 位置 | 内容 | 频率 |
|:--|:--|:--|:--|
| **首** | 每条用户消息开头 | `【用中文思考】你的推理过程必须全程使用中文。即使遇到英文内容，也必须用中文推理，仅保留英文术语原样。` | 每条消息 |
| **中** | system message | 全量指令（含例外边界和场景列表） | 首次 + 每 3 条刷新 |
| **尾** | 消息末尾 | `🔒 【思考锚点】用中文继续推理，遇到英文内容时用中文分析，仅保留技术原语。` | 每次 |
| **兜底** | 后处理 | 英文 thinking 自动追加中文翻译块 | 每次 |

## 安装

### 方式一：拖拽安装（推荐）

1. 在 [Releases](https://github.com/hayou2002/think-lang-control/releases) 下载 `think-lang-control-v2.7.1.zip`
2. 打开 HanaAgent → 设置 → 插件
3. 将 zip 文件拖入安装区

### 方式二：GitHub 一键安装

在 HanaAgent 中直接说：`安装技能 https://github.com/hayou2002/think-lang-control`

### 方式三：手动安装

将插件目录解压到 `~/.hanako/plugins/thinking-language/`，然后重启 HanaAgent。

## 使用

安装启用后立即生效，**当前对话和新对话均自动生效**，无需迁移。

插件自动运行，无需任何操作。每条用户消息开头会自动注入中文思考指令。

## 构建

```bash
# 插件源码结构
think-lang-control/
├── manifest.json           # 插件声明（full-access）
├── extensions/
│   └── chinese-thinking.js # Pi SDK extension 工厂
└── README.md
```

打包命令：

```bash
zip -r think-lang-control-v2.7.1.zip manifest.json extensions/ -x "*.DS_Store"
```

## 版本历史

### v2.7.1（2026-06-27）

**Bug 修复：**
- `injectMediumInstructionToAll` 因同时检查 `hasInstruction`，全量指令标记挡住了中指令的注入，导致最后一条用户消息没有中指令。修复：移除 `hasInstruction` 检查。

**增强：**
- 中指令内容强化（55字，比之前的5字更严格）

### v2.7.0

**架构重构：**
- 分层注入策略（短指令→全量指令→尾部锚点）
- 每条用户消息注入中指令
- 英文 thinking 追加中文翻译（后处理兜底）
- 旧指令清理机制
- role 大小写不敏感匹配

### v2.6.0

- 后处理翻译
- 英文 thinking 追加中文翻译块（零 API 调用，词典启发式翻译）

### v2.2.0 - v2.5.0

- 语言块检测、旧指令清理、三层注入、角色沉浸适配、错误处理

### v1.0.0

- 初始版本：首次调用时向第一条用户消息注入中文思考指令

## 许可证

Apache License 2.0
