# Tasks: Model Prompt Rules

## Slice 1 — data + prompt logic

- [ ] Add `ModelPromptRule` schema and `modelPromptRules` to persisted settings.
- [ ] Add normalization helpers and prompt-composition helper with case-insensitive substring matching.
- [ ] Add focused unit tests for normalization and prompt composition.

## Slice 2 — renderer request integration

- [ ] Update main chat send / resume / recovery flows to use the composed prompt.
- [ ] Update brainstorm requests to use the composed prompt for the actual brainstorm request model.
- [ ] Update Git agent / Git sync automation requests to use the composed prompt for the parsed git-agent model.
- [ ] Add focused tests covering the new request prompt behavior.

## Slice 3 — settings UI

- [ ] Add a Models-group summary entry for model prompt rules.
- [ ] Add a secondary dialog/page to add, edit, and delete rules.
- [ ] Save the normalized rule list back into settings.
- [ ] Add or update theme/visual coverage for the new settings surfaces.

## Slice 4 — verify + handoff

- [ ] Run targeted unit tests and quality checks.
- [ ] Run the narrowest viable theme/UI verification for both light and dark themes.
- [ ] Restart the active runtime before handoff.
