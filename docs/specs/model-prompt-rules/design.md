# Design: Model Prompt Rules

## Overview

We add a persisted `modelPromptRules` array to app settings. Each rule has:

- `id`
- `modelMatch` — a case-insensitive substring keyword
- `prompt` — extra system prompt text to append

The renderer remains the source of truth for the current unsaved settings state, so prompt composition happens **before** each request is sent. That avoids relying on queued persistence or runtime-setting sync for correctness.

## Data Model

Add a new setting collection:

- `AppSettings.modelPromptRules: ModelPromptRule[]`
- `ModelPromptRule = { id: string; modelMatch: string; prompt: string }`

Normalization rules:

- trim `modelMatch`
- trim `prompt`
- drop entries whose `modelMatch` or `prompt` is empty after trimming
- preserve order of surviving rules
- generate no implicit default rules; the default value is `[]`

## Prompt Composition

Introduce a shared helper that:

1. normalizes the base system prompt as today
2. finds rules whose `modelMatch` is a case-insensitive substring of the final request model name
3. appends matched rule prompts after the base prompt, separated by blank lines

Example:

- base prompt: `Always verify before claiming success.`
- model: `claude-sonnet-4-6`
- rules:
  - `claude` → `Use concise review bullets.`
  - `sonnet` → `Prefer faster tradeoffs when possible.`

Result:

```text
Always verify before claiming success.

Use concise review bullets.

Prefer faster tradeoffs when possible.
```

## Request Surfaces

Apply the helper at every renderer request entry point that already supplies a system prompt:

- main chat send / resume / stream recovery in `src/App.tsx`
- brainstorm runs in `src/components/BrainstormCard.tsx`
- Git agent analysis / conflict-sync runs in `src/components/GitAgentPanel.tsx` and `src/components/GitSyncPanel.tsx`

For Git and Brainstorm flows, the rule match should use the **actual model being requested**, not the visible chat card model when they differ.

## UI

### Main settings surface

Within the Models settings group:

- keep the existing global system prompt textarea
- add a new compact row/entry for model prompt rules
- show summary text such as rule count and first matching keyword preview
- provide an “Edit rules” action

### Secondary editor

Use a modal/dialog style secondary page consistent with existing structured-preview overlays:

- title + short note explaining substring matching
- list of existing rules as compact cards
- add rule button
- per-rule edit / delete actions
- local draft state inside the dialog
- save commits the full normalized rule list into settings
- cancel closes without mutating persisted app state

This keeps incomplete drafts out of the reducer/state until the user saves.

## Theming

The dialog reuses existing shared dialog/backdrop tokens and adds only minimal settings-specific styling. The summary row and rule cards must be readable in both themes and keep idle chrome quiet.

## Risks

- Missing one request path would make rules feel unreliable. Mitigation: central helper + targeted tests for each risk-heavy request family.
- Persisting incomplete rules would create confusing no-op state. Mitigation: local dialog draft + normalization filter on save and load.
- Overly broad matching could surprise users. Mitigation: clearly label the field as model keyword / substring matching in the editor copy.
