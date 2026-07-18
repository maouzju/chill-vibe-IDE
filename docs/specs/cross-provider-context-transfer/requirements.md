# Cross-Provider Context Transfer — Requirements

## Problem

Conversation forks can preserve a provider-native session while the card stays on the same
provider/model. That guarantee collapses when the user changes the forked card from Claude/Fable
to Codex/Sol: the Claude session cannot be resumed by Codex, so the renderer falls back to the
generic seeded transcript. That fallback has a small transport-oriented budget and lets recent
structured command output crowd out earlier user/assistant dialogue. Long conversations therefore
feel as if the new model forgot the task.

## Requirements

1. **R1 — High-fidelity Fable → Sol transfer.** When a non-empty card changes from
   Claude/Fable to Codex/Sol, the first Codex turn must receive the complete meaningful visible
   dialogue before answering. Earlier goals and decisions must not be displaced by recent command
   or tool activity.
2. **R2 — Native sessions remain model-bound.** Chill Vibe must not resume a Claude session through
   Codex, or resume any provider-native session under a different effective model.
3. **R3 — Preserve a return anchor.** The source provider/model/session metadata must survive the
   switch. Switching back before or after the first target-provider turn should restore the source
   native session when its provider and model still match.
4. **R4 — Structured activity is secondary.** Transfer replay should preserve user and assistant
   prose first. Command/tool/reasoning details may use the existing bounded representation and must
   not evict meaningful dialogue.
5. **R5 — Safe fallback.** Sessionless forks, stale-session recovery, and Claude-target replay keep
   the existing bounded seeded behavior unless they are explicitly using the Codex model-transfer
   path.
6. **R6 — Persistence compatibility.** Existing saved state without transfer metadata must load
   unchanged. Pending/alternate transfer metadata must survive ordinary state save, history archive,
   and history restore.
7. **R7 — One-time transfer semantics.** Once the target provider has a matching native session,
   later turns resume it normally rather than replaying the transferred dialogue on every send.

## Non-goals

- Importing Claude's native JSONL format directly into a Codex rollout file.
- Replaying provider-private system prompts or hidden chain-of-thought into another provider.
- Removing the generic bounded seeded replay used as the final recovery fallback.
- Broadly redesigning provider session storage in this slice.

