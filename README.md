# 思考语言控制 · Think in Chinese

强制所有大语言模型的 `reasoning_content` / `thinking` 中使用中文进行内部推理。
兼容 DeepSeek、GPT、Claude、Qwen 等所有支持推理输出的模型。

## 特点

- **零配置**：安装启用即生效，无需任何配置
- **通用兼容**：通过 Pi SDK extension 机制注入指令，对所有模型生效
- **双钩子架构**：`context`（消息层）+ `before_provider_request`（请求体层）
- **动态 Prefill**：根据用户消息的语言和关键词，自动生成中文 assistant 开头
- **自适应注入**：根据英文密度动态调整注入频率，避免 token 浪费
- **请求体参数注入**：`locale`、`language`、`thinking`、`user` 四个参数全模型覆盖
- **结构化摘要兜底**：英文 thinking 自动追加中文推理摘要
- **旧指令清理**：自动清理历史注入，防止 token 累积

## 工作原理

插件通过 HanaAgent 的 `extensions/`（Pi SDK Extension）钩子在每次 LLM 调用前执行分层处理：

### context 钩子（消息层）

| 步骤 | 位置 | 内容 | 频率 |
|:--|:--|:--|:--|
| 1 | 所有消息 | 清理旧注入（防 token 累积） | 每次 |
| 2 | assistant 消息 | 英文 thinking 追加中文结构化摘要 | 每次检测到英文 |
| 3 | system message 开头 | 全量中文指令（含推理内容专属要求） | 首次 + 每轮刷新 |
| 4 | 最近用户消息 | 短指令 `【用中文思考】` | 自适应（英文密度超阈值时注入） |
| 5 | 对话末尾 | 动态中文 prefill（按关键词生成） | 每次 |

### before_provider_request 钩子（请求体层）

| 参数 | 值 | 作用 |
|:--|:--|:--|
| `locale` | `"zh-CN"` | 语言区域提示 |
| `language` | `"zh"` | 语言偏好提示 |
| `thinking` | `{ type: "enabled" }` | 启用推理模式（部分模型支持） |
| `user` | `"zh-CN-user"` | 用户标识（辅助语言推断） |

### 动态 Prefill 策略

根据最后一条用户消息的语言自动选择 prefill 内容：

- **中文问题**：`"好的，让我认真思考一下这个问题。先理解用户的具体需求，然后逐层分析，确保思路清晰完整。除英文技术术语保留原名外，整个过程我都用中文来思考和表达。"`
- **英文问题**：提取关键词（如 TCP、API、数据库），生成 `"好的，让我来分析这个关于TCP协议、API接口的问题。先梳理相关的核心概念和技术要点，理解它们之间的关系。然后逐步对比分析，把关键区别和适用场景说清楚。整个过程我用中文来组织思路，英文术语只保留原名，分析和判断都用中文。"`

## 安装

将 `thinking-language` 文件夹复制到 HanaAgent 的插件目录：

```
.hanako/plugins/thinking-language/
├── manifest.json
└── extensions/
    └── chinese-thinking.js
```

重启 HanaAgent 即可生效。

## 测试结果

| 提示词类型 | 轮1 | 轮2 | 轮3 |
|:--|:--|:--|:--|
| 纯英文技术问题 | ✅ 中文 | ✅ 中文 | ✅ 中文 |
| 纯中文代码问题 | ✅ 中文 | ✅ 中文 | ✅ 中文 |
| 中英混合问题 | ✅ 中文 | ✅ 中文 | ✅ 中文 |

## 版本历史

| 版本 | 改动 |
|:--|:--|
| v3.3 | 全模型请求体参数注入 + 动态长 prefill + 推理专属指令 |
| v3.2 | prefill 拉长 + reasoning_content 专属指令 + 半英半中修复 |
| v3.1 | 动态 prefill（按关键词生成中文开头）+ 结构化摘要替代单词替换 |
| v3.0 | 双钩子架构 + system prepend + assistant prefill + 自适应注入 |
| v2.7 | 每条消息注入 + system 每3条刷新 + 后处理翻译 + 尾部锚点 |

## 许可证

MIT
