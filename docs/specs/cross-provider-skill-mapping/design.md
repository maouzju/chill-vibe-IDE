# 跨 Provider Skill 映射与去重设计

## 核心模型

以规范化后的 Skill 名称作为映射键。映射的 Provider 顺序始终为：

1. 当前运行 Provider。
2. 开启互相复用时的另一 Provider。

现有 `discoverProviderSkills()` 已按传入 Provider 顺序保留第一个同名 Skill，因此统一使用
`getReusableSkillProviders(currentProvider, enabled)` 即可得到当前运行的有效 Skill 映射。

## 运行时注入

跨 Provider 系统提示词不再只扫描另一 Provider。它会：

1. 生成当前运行的完整有效 Skill 映射。
2. 只保留映射结果中 `skillProvider !== currentProvider` 的条目。
3. 排除本次已经通过 `/skill` 显式展开的 Skill 名称。
4. 把剩余条目作为“外部 Skill 名称 → SKILL.md 路径”的映射注入系统提示词。

这样可以同时避免：

- 当前 Provider 原生 Skill 与外部同名 Skill 重复。
- 显式 `/skill` 指令与通用外部 Skill 清单重复。

## 请求编排

`launchProviderRun()` 在启动 CLI 前先解析一次显式 Skill：

- `prepareProviderSkillReuse()` 只发现一次当前运行的有效 Skill 映射。
- 找到显式 Skill：使用已有 `buildSkillSlashPrompt()` 展开用户请求，并在格式化系统提示词前从外部 Skill 清单排除该名称。
- 未找到：保持原提示词，正常构建外部 Skill 映射。

斜杠菜单和显式解析继续复用相同的发现顺序，保证 UI 看到的 Skill 与实际执行的一致。

## 风险与边界

- Skill 名称来自 frontmatter 或目录名，并统一转为小写，因此按名称去重稳定且可解释。
- 首版不读取完整文件做内容哈希，避免每次运行增加额外 I/O，也避免不同名称但相似内容被误判为重复。
- 当前 Provider Skill 优先是安全默认值，因为该 Provider 可能已经原生加载对应目录。
