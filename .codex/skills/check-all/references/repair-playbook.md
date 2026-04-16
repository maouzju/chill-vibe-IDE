# Repair Playbook

## Artifact Map

- `summary.json`: machine-readable run summary from `run-check-all.ps1`
- `logs/*.log`: one log per verification step
- `reports/<step>/test-results`: Playwright failure attachments and screenshots when present
- `reports/<step>/playwright-report`: copied HTML report folder when present
- `reports/<step>/test-electron-dev.*.log`: copied Electron renderer boot logs when present

## Ranking Heuristic

Sort findings in this order before fixing:

1. deterministic product regressions with a failing proving test
2. Electron boot or bridge failures that block wider confidence
3. screenshot-backed UI regressions or broken interaction states
4. environment or harness issues that can invalidate the evidence
5. screenshot-backed UI opportunities that improve polish but are not regressions

## Triage Questions

Ask these questions for every issue:

- Is this a real product problem or one of the repo pitfalls already documented in `AGENTS.md`?
- What is the narrowest proving test or snapshot that should fail before the fix?
- Does the fix touch a schema, persisted state shape, reducer mutation, server handler, or Electron bridge?
- Does the UI surface need explicit light and dark snapshot coverage after the fix?
- Is the issue independent enough to hand to a worker without overlapping write scope?

## UI Opportunity Checklist

Review screenshots for:

- board seams or title bars that no longer line up
- inactive chrome that can be removed entirely
- components that use literal colors instead of existing tokens
- low-contrast text, icons, or drag targets in either theme
- clipped labels, awkward truncation, or overflow in narrow layouts
- focus order or hover states that are too subtle to discover

Record a UI opportunity when the screenshots make the experience feel worse even if no automated test fails yet.

## Worker Prompt Templates

Use these templates when delegating. Replace the placeholders but keep the structure tight.

### Logic worker

`Use $check-all at <skill-path> to fix <issue>. Own <files>. Another agent may edit other files, so do not revert unrelated changes. Run <narrow test> after your change and report touched files plus remaining risks.`

### UI worker

`Use $check-all at <skill-path> to improve <surface> based on the attached screenshot evidence. Own <files>. Preserve the existing design system, add or update the narrowest screenshot coverage you need, and rerun <theme or Playwright spec>.`

### Test worker

`Use $check-all at <skill-path> to add or tighten coverage for <issue>. Own <test files>. Do not change production code unless the test cannot be written otherwise. Run the new or updated test and report the exact command used.`

## Delegation Guardrails

- Do not delegate two workers into the same reducer, component, or shared schema without a strong reason.
- Do not delegate the first root-cause investigation when the next local action depends on it.
- Do not ask a worker to "look around" broadly. Give one issue, one evidence bundle, one proving test, and one owned write scope.
- After workers return, integrate locally and rerun the broad sweep yourself.
