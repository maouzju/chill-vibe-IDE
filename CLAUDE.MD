# Claude Instructions

> **⚠️ MANDATORY — READ [`AGENTS.md`](./AGENTS.md) BEFORE ANY CODE CHANGE ⚠️**
>
> This repo uses [`AGENTS.md`](./AGENTS.md) as the **sole source of truth** for all AI agent behavior.
> You **MUST** read and internalize `AGENTS.md` in full before writing or modifying any code.
> Skipping it is **not acceptable** — it contains the TDD workflow, tier rules, theme safety checks, and pitfall list that govern every change.
>
> **Key non-negotiable from AGENTS.md:**
> - **Tier 1 (logic changes): red → green TDD is required.** Write a failing test FIRST, confirm it fails, THEN implement the fix, THEN confirm the test passes. No exceptions.
> - **Tier 2 (style changes): visual regression snapshots are required.**
> - **All tiers: never finish with an unverified code change.**
>
> If you proceed without following these rules, your output is considered invalid.

## Bug 兜底策略

如果遇到难以处理的 bug（例如反复尝试 2 次以上仍无法定位根因），需要调用 Codex CLI 来兜底排查：

```bash
codex "请分析以下 bug 并给出修复方案: <bug 描述>"
```

优先自行排查，Codex CLI 作为最后手段使用。
