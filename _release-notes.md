## v2.7.1 (2026-06-27)

### Bug 修复

- injectMediumInstructionToAll 同时检查 hasInstruction, 全量指令标记挡住了中指令的注入, 导致最后一条用户消息没有中指令
- 修复: 只检查 hasMediumInstruction, 全量指令不影响中指令注入

### 增强

- 中指令内容从5字强化为55字
