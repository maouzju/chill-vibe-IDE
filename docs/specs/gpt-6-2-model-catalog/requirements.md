# Requirements: GPT-6.2 模型目录升级

## 目标
将 GPT-6.2 Sol 与 GPT-6.2 Astra 纳入 Codex 模型选择器，并保留旧模型别名与已保存卡片兼容性。

## 验收标准
- 选择器显示 GPT-6.2 Sol 与 GPT-6.2 Astra。
- GPT-6.1 Sol 与 GPT-6 Astra 从普通选择器隐藏，但旧别名和已保存模型仍可解析。
- 旧 Sol、旧 Astra 以及 GPT-5.6 Sol 的升级提示指向对应 GPT-6.2 模型。
- GPT-6.2 Sol/Astra 的推理选项符合当前 CLI 能力约束。
- 选择器滚轮、升级提示、模型发现和主题快照测试覆盖以上行为。
