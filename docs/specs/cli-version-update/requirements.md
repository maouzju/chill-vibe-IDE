# CLI 版本更新需求

## 背景

设置页已经支持一键安装缺失的 Git、Node、Claude CLI、Codex CLI，但已有 CLI 时只跳过，不会升级。用户需要在设置里主动把 Claude / Codex CLI 更新到指定版本，且默认更新到最新版。

## 需求

1. 设置页环境区域必须提供「更新 CLI」入口，可选择 Claude、Codex 或两者一起更新。
2. 版本输入为空时必须按 `latest` 处理。
3. 版本输入非空时必须安装到用户填写的 npm dist-tag 或 semver 版本，例如 `latest`、`1.2.3`、`0.10.0-beta.1`。
4. 更新动作必须复用现有安装日志和状态卡，让用户看到执行过程和失败原因。
5. 只更新 Claude / Codex CLI，不改变 Git、Node 或路由/API 配置。
6. Windows 自动更新沿用现有 PowerShell 脚本和 Electron/服务端 IPC 通道；非 Windows 保持 unsupported 状态。

## 非目标

- 不做可视化版本列表拉取。
- 不自动修改用户的 npm registry。
- 不在更新完成后自动启动登录或认证流程。
