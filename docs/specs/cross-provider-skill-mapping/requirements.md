# 跨 Provider Skill 映射与去重需求

## 背景

Chill Vibe 已支持 Codex 与 Claude 互相发现 `.codex/skills`、`.claude/skills`。当前斜杠菜单会按名称去重，但实际运行时仍可能把同一个逻辑 Skill 重复暴露给模型：

- 当前 Provider 已原生加载同名 Skill，系统提示词又注入另一个 Provider 的同名 Skill。
- 用户显式输入 `/skill-name` 后，请求正文已经指向该 `SKILL.md`，系统提示词仍再次列出它。

## 目标

1. 每次运行建立一份按 Skill 名称索引的有效映射。
2. 当前 Provider 的 Skill 优先于另一 Provider 的同名 Skill。
3. 工作区 Skill 继续优先于同 Provider 的用户目录 Skill。
4. 只把“另一 Provider 独有”的 Skill 注入当前 Provider 的系统提示词。
5. 用户显式调用的跨 Provider Skill 在该次运行中只引用一次，不再同时出现在通用映射清单里。
6. 斜杠菜单、`/skill` 解析和实际运行使用相同的名称优先级。

## 验收标准

- [x] Codex 运行默认可复用 Claude Skill，Claude 运行默认可复用 Codex Skill。
- [x] `.codex/skills/foo` 与 `.claude/skills/foo` 同时存在时，Codex 选择 Codex 版本，Claude 选择 Claude 版本。
- [x] 当前 Provider 已有同名 Skill 时，跨 Provider 系统提示词不再列出另一份同名 Skill。
- [x] 显式输入 `/foo ...` 并解析到跨 Provider Skill 时，请求正文指向一次 `SKILL.md`，系统提示词不再重复列出 `foo`。
- [x] 不同名称的跨 Provider Skill 仍可正常出现在映射清单中。
- [x] 关闭“Codex / Claude Skill 互相复用”后维持完全隔离。

## 非目标

- 不复制、移动或创建 Skill 文件。
- 不把 Claude CLI 切换成 Codex CLI，反之亦然。
- 不尝试判断两个不同名称的 Skill 内容是否语义相同；首版仅按规范化名称去重。
