# 思考语言控制 — Think in Chinese

强制所有大语言模型在 `reasoning_content` / `thinking` 中使用中文进行内部推理。

兼容 DeepSeek、GPT、Claude、Qwen 等所有支持 `reasoning_content` 或 `thinking` 输出的推理模型。

## 特点

- **零配置**：安装启用即生效，无需任何配置
- **通用兼容**：通过 Pi SDK extension 机制注入指令，对所有模型生效
- **轻量无感**：仅 6KB，微秒级注入，不影响模型调用性能
- **无损兼容**：不修改系统提示词、技能、插件和挂载文件
- **老对话适用**：安装后当前对话和新对话均自动生效，无需迁移
- **英文感知**：自动检测上下文中的英文内容（网页、代码、文档），实时加固中文推理指令
- **语言块检测**：即使中文注释把整体英文比例拉低，仍能通过代码标识符检测到英文内容
- **周期刷新**：每 3 条用户消息自动刷新指令，防止被上下文稀释

## 工作原理

插件通过 HanaAgent 的 `extensions/`（Pi SDK Extension）钩住 `context` 事件。在每次 LLM 调用前，注入中文思考指令：

```
模型调用前 → 核心扩展 → 本插件检测+注入【思考语言要求】→ 发送 API 请求
```

### 注入策略（v2.2）

1. **末尾锚定**：指令注入到最后一条用户消息（而非第一条），最大化推理时的影响力
2. **两级英文检测**：
   - 整体比例：ASCII 字母占非空白字符 > 50%
   - 语言块：存在 3+ 个英文标识符（变量名、函数名、关键字），即使中文注释稀释了整体比例也能检测到
3. **周期刷新**：每 3 条用户消息刷新一次，防止指令被长对话稀释
4. **智能去重**：先剥离旧指令再注入新指令，避免重复堆叠

### 英文内容检测

插件会分析上下文中所有消息的英文含量，覆盖：

| 场景 | 示例 |
|:--|:--|
| 网页抓取 | GitHub 页面、Stack Overflow、技术文档 |
| 代码文件 | .js / .py / .ts 等源码文件（含中文注释） |
| 工具返回 | web_fetch / browser / read 工具的结果 |
| 混合内容 | 含英文代码的 Markdown、中英混合文档 |

## 安装

### 方式一：拖拽安装（推荐）

1. 在 [Releases](https://github.com/hayou2002/think-lang-control/releases) 下载 `think-lang-control-v2.2.0.zip`
2. 打开 HanaAgent → 设置 → 插件
3. 将 zip 文件拖入安装区

### 方式二：GitHub 一键安装

在 HanaAgent 中直接说：`安装技能 https://github.com/hayou2002/think-lang-control`

### 方式三：手动安装

将插件目录解压到 `~/.hanako/plugins/thinking-language/`，然后重启 HanaAgent。

## 使用

安装启用后立即生效，**当前对话和新对话均自动生效**，无需迁移。

插件自动运行，无需任何操作。模型的 `reasoning_content` / `thinking` 将自动使用中文。

## 构建

```bash
# 插件源码结构
think-lang-control/
├── manifest.json           # 插件声明（full-access）
├── extensions/
│   └── chinese-thinking.js # Pi SDK extension 工厂
├── releases/               # 打包好的 zip
└── README.md
```

打包命令：

```bash
zip -r think-lang-control-v2.2.0.zip manifest.json extensions/ -x "*.DS_Store"
```

## 更新日志

### v2.2.0（2026-06-27）

**增强：**

- 新增"语言块检测"：即使中文注释把整体英文比例拉低，只要存在 3+ 个英文标识符（变量名、函数名、关键字），仍触发注入
- `messagesSinceInjection` 兼容 role 为 "human" 等变体格式

**修复：**

- `applyInstruction` 数组格式剥离旧指令时，剥离后未用更新的 block 继续检查的问题（改为先扫描再统一剥离）

### v2.1.0

**Bug 修复：**

- `extractText` 不读 `tool_result` 的 `content` 字段，导致 `web_fetch` / `browser` 返回的英文内容从未被检测到
- `isEnglishHeavy` 不剥离 HTML 标签，GitHub 返回的 HTML 标签稀释英文占比导致漏检
- `isEnglishHeavy` 错误地剥离了代码块和行内代码，但代码本身就是英文内容

**增强：**

- 指令文本强化：明确提及 GitHub、Stack Overflow、PR、Issue、README 等场景
- 检查窗口从最近 3 条消息扩大到 5 条
- 最短检测长度从 30 降到 10 字符
- 指令注入位置从第一条用户消息改为最后一条

### v2.0.0

- 注入位置从第一条用户消息改为最后一条
- 新增周期性刷新机制（每 3 条用户消息）
- 新增英文内容感知检测
- 新增智能去重（先剥离旧指令再注入新指令）

### v1.0.0

- 初始版本：首次调用时向第一条用户消息注入中文思考指令

## 许可证

Apache License 2.0
