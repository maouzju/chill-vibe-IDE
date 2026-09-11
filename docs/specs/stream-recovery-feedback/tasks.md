# Stream Recovery Feedback — Tasks

## Slice 1 — pure transition helpers (red → green)

1. Create `tests/stream-recovery-feedback.test.ts` with failing cases for:
   - `computeRecoveryStatusAfterRetryScheduled` produces `{ kind: 'reconnecting', attempt: retryCount + 1, max }`.
   - `computeRecoveryStatusAfterSuccess` returns `{ kind: 'resumed' }` only when previous was `reconnecting`; returns previous otherwise.
   - `computeRecoveryStatusAfterFinalFailure` returns `{ kind: 'failed' }`.
   - `shouldClearRecoveryStatusOnStreamIdle` returns false for `failed`, true for others / undefined.
2. Register the new test in `tests/index.test.ts`.
3. Run — confirm red.
4. Create `src/stream-recovery-feedback.ts` with the helpers.
5. Run — confirm green.

## Slice 2 — i18n

6. Add `streamRecoveryReconnecting`, `streamRecoveryResumed`, `streamRecoveryFailed` to the `LocaleText` type and both zh-CN and en-US dictionaries in `shared/i18n.ts`.

## Slice 3 — UI wiring

7. Update `StreamingIndicator` in `src/components/MessageBubble.tsx` to accept `recoveryStatus` prop and render the localized label when present.
8. Thread `recoveryStatus` from `ChatCardView` → `ChatTranscript` → `StreamingIndicator`.

## Slice 4 — App.tsx state management

9. Add `recoveryStatuses` state in `App.tsx`.
10. Dispatch on:
    - `onError` recoverable branch → `reconnecting`.
    - `onError` final failure (including retry budget exhaustion) → `failed`.
    - `onData` when a reset predicate returns true for the card → `resumed` + schedule 2s timer to clear.
    - Card transitions from `streaming` → non-streaming: clear via `shouldClearRecoveryStatusOnStreamIdle`.
11. Pass `recoveryStatus={recoveryStatuses.get(card.id)}` to each `ChatCardView`.

## Slice 5 - Codex native placeholder handling

12. Treat stderr-only and JSON-RPC-error-only Codex native `Reconnecting... n/5` diagnostics as recovery control signals.
13. Keep those diagnostics out of final user-visible error text and record one local reconnect disconnect stat.
14. Add focused provider tests for stderr-only and JSON-RPC-error-only placeholder suppression and stats.

## Slice 6 - active resume and silent-stall recovery

15. Add focused provider tests showing an `active` Codex `thread/resume` still receives a follow-up blank `turn/start`.
16. Implement the active-resume continuation path so recovered cards cannot remain on `Thinking` with no terminal event.
17. Add focused provider tests for a local Codex stream that accepts `turn/start` but emits no visible output or terminal event before the first-byte timeout.
18. Implement the local stream stall watchdog and classify the timeout as recoverable `resume-session`, pausing it while command activity is in progress.

## Slice 6A - dead non-transient resume escape hatch

19. Add a red-first helper test proving two consecutive ordinary `resume-session` stall failures switch to fresh-session recovery even when `transientOnly` is false.
20. Count all failed session-resume turns in `App.tsx`, clear the count only after terminal cleanup/new user control flow, and route the threshold hit through the shared recovery entry used by **手动续传**.

## Slice 6B - lossless native-checkpoint recovery

21. Add red-first tests for conservative current-turn selection and a runtime recovery that forks before the failed user turn, keeps the native context, and replays only that turn.
22. Reuse `forkProviderSession` from the lossless-fork flow in automatic recovery and **手动续传**.
23. Keep seeded transcript replay only when native fork creation is unavailable or the current turn cannot be mapped safely.

## Slice 7 - verification

24. Run the focused unit/runtime recovery tests and confirm green.
25. Run `pnpm test:quality` (narrow scope).
26. Restart the active runtime (Electron via `pnpm dev:restart`).
27. Update handoff notes.

## Slice 8 - 2026-07-28 overnight stale Codex stream

28. Reproduce the field chain: native rollout completed, renderer card remained streaming, restart injected `Please continue.`.
29. Add Codex rollout-tail completion classification and use it before automatic resume.
30. Bound silent Codex commands and sub-agent waits with the shared absolute hard cap.
31. Add red→green provider and browser regressions for missing terminal events and stale-stream send-now recovery.

## Slice 9 - 2026-07-28 packaged bridge and compact queue deadlock

32. Add a red desktop-backend test proving packaged Codex `task_complete` is not discarded as `unknown`.
33. Remove the Claude-only Electron bridge guard and prove the desktop path returns `completed`.
34. Add a red browser test for `/compact` → deferred follow-up → **Send now** with no old-stream `done`.
35. Preserve ordinary compact waiting, but let explicit interrupt escape the compact boundary and locally settle impossible streaming-without-streamId states.

## Slice 10 - transient API connection refusal

36. Add a red-first provider recovery test for `API Error: Unable to connect to API (ConnectionRefused)` (plus the common spaced/`ECONNREFUSED` spellings) with a live session.
37. Classify those explicit short-lived connection failures as bounded `resume-session` errors while keeping the no-session guard.
38. Run the focused provider recovery tests and `pnpm test:quality`; package the verified bug fix and restart the active runtime.

## Slice 11 - completed command label (2026-09-06)

- [x] Reproduce completed command and legacy-command-plus-reply labels with failing tests.
- [x] Exclude terminal work while preserving explicitly active concurrent work and snapshot-specific lifecycles.
- [x] Verify current-turn boundaries, light/dark command-group rendering, and package alongside the child-completion repair.

Verification: `tests/message-local-link.test.ts` passed 25/25 after red-first coverage; the file-scoped `streaming structured command groups` Playwright case passed in both themes with unchanged snapshots. Default `pnpm test:theme` was blocked by another project's 5173 listener, so verification used a temporary derived repo config on port 5196. Quality passed; Windows handoff shares `dist/release-20260906-224336/` with the child-completion fix. This scoped repair extends the existing SPEC rather than creating a new feature SPEC.

## Slice 12 - Codex native retry noise (2026-09-06)

- [x] Red-first provider regressions: five retry notifications append no logs, emit one backend-recorded disconnect, and retain the final diagnostic; recovery may continue output and complete normally.
- [x] Red-first fixed-phrase classification with live-session and permanent-error guards.
- [x] Red-first renderer regression: backend-recorded stats show reconnecting without starting another request or duplicating stats, then real output resumes.
- [x] Replace intermediate raw log emission with the existing stats signal and wire that signal to existing recovery feedback.
- [x] Separate native reconnect feedback from the IDE retry denominator and re-arm feedback after real output without duplicating the per-run disconnect count.
- [x] Preserve an existing IDE resume counter across native retry notifications; red-first `scheduled -> native -> scheduled` coverage proves unlimited placeholder-only attempts advance from 1 to 2.
- [x] Verify focused provider, classifier, and renderer coverage, then share integrated quality/package evidence in the parent handoff.

Integrated verification (2026-09-06): 126 focused classifier/parser/renderer/helper Node tests plus 25 Codex provider cases passed. All 21 targeted browser recovery/theme cases passed on isolated port 5198; `pnpm test:quality` passed. Six new snapshots were reviewed, preserving actual failures and valid agent results. `pnpm test:theme` could not own 5173 because another project uses it; no user process was stopped. `pnpm electron:build` produced `dist/release-20260906-232949/Chill Vibe-0.20.15-win.zip` plus `win-unpacked/Chill Vibe.exe`. The existing packaged user instance remains running, so the fix takes effect when switching to the new build. This is a focused extension of the existing SPEC, not a new feature or a claim to fix remote service capacity.

Node verification: the initial five-case proving run failed four cases (5 raw retry logs instead of 0, and both screenshot phrases classified as non-recoverable), then passed 5/5. The additional native-label/second-disconnect red tests failed before their implementation, then passed. Final focused checks passed 77/77 helper/classifier/MessageBubble tests and 19/19 Codex reconnect/provider tests, including backend record-count verification and final finite-budget recovery. Renderer red was confirmed on the isolated port 5198 because the reconnect element was missing; integrated green/theme/quality/package verification is tracked by the parent handoff.


## Slice 13 - unclassified TLS code and relay 503 (2026-09-10)

- [x] Red-first classifier coverage: `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` with a live session resumes, without a session stays a start failure, and the four CLI-classified certificate phrasings stay permanent.
- [x] Red-first classifier coverage: `503 No accounts are currently available` resumes both with and without the CLI >=500 suffix, and stays non-resumable without a session.
- [x] Exempt the single Bun fallback code from the permanent-certificate exclusion and pin both literal substrings in `recoverableErrorPatterns`.
- [x] Run the focused provider recovery tests and `pnpm test:quality`; package the verified bug fix.

2026-09-11 续接验证：接手时本切片的代码与测试已在工作区，未重写生产逻辑。把当前测试放到隔离副本，对照 `HEAD` 分类器得到预期的 2 项失败（未知证书码、无 CLI 后缀的 503）；当前分类器与续传策略/反馈测试共 86 项通过。证据位于 `dist/tls-recovery-proof-20260911/`。整库 `pnpm test:quality` 的 lint 通过，但另一个尚未完成的停止会话切片在 `server/index.ts:936` 读取不存在的 `ChatStreamStopResult.interrupted`，导致类型检查失败；本次不修改该切片，改在仅包含本修复的隔离候选上验证和打包。沿用现有 `stream-recovery-feedback` SPEC 与 AGENTS.md 的窄范围恢复规则，不另建功能 SPEC。

交付确认：修复已独立提交为 `5d26578`；在该提交的干净隔离候选上，86 项定向测试与 `pnpm test:quality` 全通过，`pnpm electron:build` 成功。产物已移回主仓库 `dist/release-20260911-155631/Chill Vibe-0.20.19-win.zip`，免解压入口为同目录 `win-unpacked/Chill Vibe.exe`。从包内 `app.asar` 提取分类器确认与已验证编译产物逐字节相同，并实际断言未知 TLS 错误进入续传、无 session 与证书过期仍不续传；ZIP 顶层仅有 `Chill Vibe IDE`。当前用户运行的是 `release-20260910-133457` 发布包，按规则未关闭或重启，修复需切换新包后生效。此次只交付窄范围修复，不包含其他未完成改动，也未发布 GitHub Release。
