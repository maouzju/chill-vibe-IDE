# Requirements: JEV 快速判断 MCP（设置开关）

## 背景

2026-09-29/30 用户要求：在设置里接入 JEV（TypeSafe 的非生成式判断模型），作为 agent 会话里 AI 可以自己选择调用的 MCP 工具，用来提速「批量筛选/分类/打分」这类判断活；设置里要讲清楚 MCP 和 JEV 分别是什么；注入模型的上下文必须精简；只有设置里打开才生效。

调研结论（见 memory `jev-integration-research`）：社区 MCP 形态最稳的用法是「批量筛文件」一个工具；JEV 只回答是否/选择/打分，70–500ms，$0.042/M 输入、输出免费；原生 Windows 实测中位约 1s，对单次判断并不比 Haiku 快多少，价值在于**大批量并发、便宜、不占 agent 上下文**。

## 需求

1. R1 设置里新增「JEV 快速判断」一项：开关（默认关）+ API key 输入框；分类在「模型与对话」。
2. R2 文案用人话解释：MCP = 给 AI 装的外接工具插口；JEV = 只做判断不写字的小模型，适合一次筛几百个文件；需要 OpenRouter（`sk-or-` 开头）或 TypeSafe 的 key；按量付费很便宜。
3. R3 开关关闭或 key 为空：Claude / Codex 启动参数、系统提示与现状逐字节一致（不注入任何东西）。
4. R4 开关打开且有 key：两条 provider 都注入同一个 stdio MCP `chill_vibe_jev`，只暴露一个工具 `jev_ask`；系统提示追加一句话（中英），工具描述控制在几句话。
5. R5 API key 不出现在任何进程命令行 / `--mcp-config` JSON / 请求体里：落在应用数据目录的 key 文件，MCP 通过 env 拿路径读取。
6. R6 运行时一切失败 fail-open：MCP 起不来或 JEV 报错只影响这个工具的返回，不影响正常聊天。
7. R7 切换开关后下一条消息生效（Claude 常驻进程签名要带开关状态）。
8. R8 设置可填写完整 JEV 请求地址（默认空，恢复时 trim）：留空按 key 自动选择，填写时覆盖 endpoint URL 且不自动拼接路径；地址随 `ChatRequest` 传到 Claude/Codex 两条链路，并通过 MCP env 使用；旧配置保持兼容，密钥仍不进入请求或命令行。