# 设计

在 `server/providers.ts` 的单次 Codex app-server 生命周期内增加启动前预检：完成 `initialize` 后调用 `configRequirements/read`，复用现有 requirements 解析器，并把请求收窄到用户上限内允许的最宽模式。该变化只修改本次内存中的 `currentRequest`，不写 Codex 配置文件，也不冒充能够修改组织策略。

如果方法不存在或返回不可识别结构，忽略预检并继续既有兼容流程；真正的 requirements 冲突仍由原来的错误恢复逻辑兜底。

设置界面沿用“允许 Agent 修改项目文件夹外的文件”开关作为配置入口，补充自动适配说明，避免再增加一个与现有权限上限重复的控制项。打开设置时通过 Electron bridge 启动一次短生命周期 app-server 检测，展示允许的沙箱范围，并提供重新检测按钮；检测失败只影响展示，不阻断正常聊天的兼容路径。
