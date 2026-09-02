# Fable 5.1 换代 — 任务

- [x] T1 红测试：`tests/models.test.ts`（选择器/别名/头脑风暴选单）、`tests/state.test.ts`
      （陈旧 Fable 5.1 列）按 design §4 写入断言，运行确认失败
- [x] T2 `shared/models.ts`：模型表换代 + legacy 隐藏条目 + `isFableModel` + `isBrainstormRequestModelVisible`
- [x] T3 调用点收敛：`shared/reasoning.ts` 的 `isClaudeAlwaysThinkingModel` 与
      `src/state.ts` 的陈旧列保护改为引用 `isFableModel`
- [x] T4 `src/components/ChatCard.tsx`：头脑风暴选单改用共享出口，删除 `hiddenBrainstormRequestModels`
- [x] T5 验证：窄测试全绿 + `pnpm test` 全量单测 + `pnpm test:quality`
