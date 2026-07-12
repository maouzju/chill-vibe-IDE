# 跨 Provider Skill 映射与去重任务

## Slice 1 — 证明重复问题

- [x] 增加同名 Skill 测试：当前 Provider 版本必须胜出，外部同名版本不得注入。
- [x] 增加显式跨 Provider `/skill` 测试：用户提示词展开后，系统提示词不得再次列出该 Skill。
- [x] 先运行定向测试并确认失败。

## Slice 2 — 统一映射

- [x] 让跨 Provider 系统提示词基于完整有效 Skill 映射筛选外部条目。
- [x] 支持排除本次已显式展开的 Skill。
- [x] 让运行入口只解析一次显式 Skill，并复用解析结果。

## Slice 3 — 验证与交付

- [x] 定向测试通过。
- [x] `pnpm test:quality` 通过。
- [x] `pnpm electron:build` 生成 Windows 交付包。
- [x] 重启当前开发运行时并核对日志。
