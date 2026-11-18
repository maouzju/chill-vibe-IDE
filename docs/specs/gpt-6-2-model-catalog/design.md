# Design: GPT-6.2 模型目录升级

- 在 `shared/models.ts` 增加 GPT-6.2 Sol/Astra 条目。
- 通过 `hiddenFromPicker` 隐藏被替代的旧条目，不删除别名。
- 更新 `MODEL_SUCCESSORS`，使旧模型升级到 GPT-6.2 对应条目。
- 在 `shared/reasoning.ts` 中声明 GPT-6.2 模型的 reasoning 选项约束。
- 使用现有模型选择器、升级提示和主题回归测试验证 UI 与持久化兼容性。
