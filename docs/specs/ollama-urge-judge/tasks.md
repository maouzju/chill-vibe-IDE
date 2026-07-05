# 鞭策本地大模型判定 + Ollama 集成 — 任务

1. [x] SPEC
2. [ ] 红：chat-auto-urge（ask-user 拦截 / judge kind / getLatestAssistantTurnText）、auto-urge-settings（judgeMode/judgeModel）、ollama-manager（推荐/解析/baseUrl/judge）
3. [ ] 绿：schema + default-state 归一化 + chat-auto-urge + server/ollama-manager.ts + Express 路由
4. [ ] 接线：Electron 四件套 + api.ts + ChatCard judge 分支 + 设置 UI（判定方式/模型选择 + Ollama 管理区）+ i18n + CSS
5. [ ] 验证：窄单测 + test:quality + 提交 + dev 重启
