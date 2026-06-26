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

## Larger Tasks — Use Orchestration

For larger tasks (multi-step, cross-cutting, broad audits/migrations, or anything one context can't comfortably hold), drive the work through an orchestration harness instead of one long linear pass:

- **Claude:** use the `Workflow` tool (fan-out subagents, pipeline/parallel stages, adversarial verify, synthesis).
- **Codex:** use its goal mode.

Scout inline first to discover the work-list, then orchestrate over it. Keep small, well-scoped tasks linear.
