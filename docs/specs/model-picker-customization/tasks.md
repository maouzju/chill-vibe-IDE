# 模型选择器：滚轮切换 + 自定义下拉项 — Tasks

1. [x] 红：选项构建 / 步进 / 设置归一化 / 累积器用例合并在 `tests/model-picker-customization.test.ts`（已注册进 `tests/index.test.ts`）。确认失败。
2. [x] schema + default-state：新增两个设置字段、默认值、归一化。
3. [x] `shared/models.ts`：`getModelPickerOptionKey` / `isModelPickerOptionEnabled` / `listConfigurableModelPickerOptions` / `isValidCustomPickerModelName` / `buildModelPickerOptions` / `stepModelPickerOption`。
4. [x] `src/components/wheel-step.ts` 抽累积器，思考旋钮改用。
5. [x] ChatCard：选项改走 `buildModelPickerOptions`；滚轮预览 + 延迟提交。
6. [x] Props 透传 + memo 比较器。
7. [x] 设置面板 `model-picker` 分组 + 文案 + settings-model 目录。
8. [x] Playwright：`tests/model-picker-wheel.spec.ts`（滚轮预览+一次提交、滚回原样不落盘、下拉吃设置、设置开关/自定义项增删）；theme-check `model-picker-settings-{dark,light}`。
9. [x] `pnpm test:quality`、窄测试、快照；AGENTS.md 坑位表补 #405；打包。
