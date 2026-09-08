# 设计

新增 AppSettings.defaultAdminAccess，schema、默认工厂、normalizeAppSettings 同步补 false。
addTab 支持显式 adminAccess 覆盖，否则从设置播种；addColumn 只对新建的非工具卡播种，不修改传入列。
createAutomationBoardItem 的显式权限优先于设置；看板输入参数缺省时读取设置。
MCP create_session 在看板与普通 Tab 路径均显式传 false，不更改 provider 或操作系统权限。
设置入口复用 renderCodexSafetySettings，使用现有 settings-hover-detail 和 aria-describedby，不新增 CSS。

验证：先写失败的默认值、归一化及 reducer 测试，再实现；补深浅主题开关与悬停截图，运行定向测试和质量门禁。
