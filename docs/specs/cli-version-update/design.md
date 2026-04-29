# CLI 版本更新设计

## 入口

在设置页「环境设置」区域里新增 CLI 更新小节。该小节包含：

- CLI 范围选择：全部、Claude、Codex。
- 版本输入框：占位为 `latest`，留空等价于 `latest`。
- 主按钮：更新 CLI。

为了让环境已就绪时也能更新 CLI，设置页环境区域不再只在缺失工具时显示；缺失工具列表仍只在有缺失项时显示。

## 数据与 IPC

新增共享请求结构：

```ts
setupRunRequest = {
  mode?: 'install-missing' | 'update-cli'
  cli?: 'all' | 'claude' | 'codex'
  version?: string
}
```

`runEnvironmentSetup()` 接收该请求并透传到 Electron preload / main / backend / server endpoint。旧调用不传请求时等价于 `install-missing`，保证 onboarding 不受影响。

## PowerShell 脚本

`scripts/setup-ai-cli.ps1` 新增参数：

- `-Mode install-missing|update-cli`
- `-Cli all|claude|codex`
- `-Version latest`

`install-missing` 保持原行为：已有 CLI 直接跳过。

`update-cli` 行为：

- 校验 Node/npm 可用，不主动安装 Git/Node。
- 对选中的 CLI 执行 `npm install -g <package>@<version>`。
- 版本为空或空白时归一为 `latest`。
- 日志打印目标 CLI 和版本。

## 验证策略

- 先用单元测试锁定 setup manager 的参数转 PowerShell argv 行为：默认更新为 `latest`，指定版本会变成 `<package>@<version>` 的脚本参数。
- 用现有 `pnpm test` 覆盖 schema、backend、setup manager 变化。
- UI 是设置页表单变更，使用 `pnpm test:quality` 做类型和 lint 验证；如 Playwright 主题检查仍受仓库已知 runner 问题影响，则说明原因。
