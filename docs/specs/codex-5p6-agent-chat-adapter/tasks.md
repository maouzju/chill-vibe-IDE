# Codex 5.6 与 Agent 聊天参数适配任务

- [x] 对照 Codex CLI 0.144.1、本地模型目录和官方模型文档确认能力。
- [x] 编写 requirements / design / tasks。
- [x] 添加默认模型、推理能力和设置归一化红测。
- [x] 添加 app-server 参数与兼容降级红测。
- [x] 实现 GPT-5.6 模型目录、默认值和模型级推理档。
- [x] 实现 Codex 人格与 Fast 设置及所有请求路径映射。
- [x] 更新设置页文案与双主题覆盖。
- [x] 运行目标测试、质量检查和主题验证。
- [x] 构建 Windows zip，并重启当前开发运行时。
- [x] 为 Fast 加速补充高费用二次确认，取消时保持关闭。
- [x] 为 Codex delta 贯通稳定 `itemId`，修复并行活动把同一正文切成碎片的问题。
- [x] 添加消息身份与 provider 事件回归测试，运行质量检查并完成 Windows 打包。
- [x] 隐藏 Codex 中断或待续流留下的末尾空 Markdown 围栏，同时保留真实代码块。
