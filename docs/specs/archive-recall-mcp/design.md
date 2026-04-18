# Design: Archive Recall MCP

## Overview

- Build a **per-run local MCP server** for Codex that can search and reopen only the hidden message segment behind the latest compact boundary.
- The renderer prepares a lightweight archive snapshot from the card¡¯s hidden compacted messages and sends it with the chat request.
- The backend writes that snapshot to a temporary JSON file, injects a temporary MCP server config into the spawned Codex app-server process, and adds a short instruction telling Codex when to use the recall tools.

## Architecture

- Frontend:
  - Add a helper that derives `archiveRecall` from the card¡¯s current message list.
  - Only include hidden messages when `getCompactMessageWindow(...).hiddenReason === 'compact'`.
  - Attach the snapshot to Codex chat requests (normal send + interrupted-session resume).
- State / schema:
  - Extend `ChatRequest` with optional `archiveRecall` metadata.
  - Reuse `ChatMessage` data so attachments still travel via existing message meta.
- Backend / Electron:
  - Add an archive-recall helper that materializes the snapshot into a temp JSON file.
  - Inject Codex runtime config overrides for a temp stdio MCP server (`node .../archive-recall-mcp.js`).
  - Append a concise Codex instruction telling the model to search/read compacted history before saying older attachments are unavailable.
  - Remove the temp snapshot file when the run settles.
- MCP server:
  - Implement minimal stdio MCP lifecycle (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`).
  - Expose two read-only tools:
    - `search_compacted_history(query, limit?)`
    - `read_compacted_history(itemId)`
  - `search` performs simple keyword / attachment-name matching over archived messages.
  - `read` returns the archived message text plus attached images as MCP image blocks.
- Persistence / migration:
  - None. Snapshot files are ephemeral and scoped to a single run.

## UX Notes

- No new heavy UI surface in this first slice.
- Existing compaction UI stays the same; the behavioral improvement is that Codex can now recover compacted history instead of immediately saying it cannot see it.
- The tool descriptions and injected instruction must emphasize **read-only**, **current thread only**, and **use only when relevant**.

## Risks

- MCP startup or protocol mismatch could make Codex runs fail if the server is malformed; keep the protocol surface tiny and cover it with focused tests.
- Returning large images as base64 can bloat tool results; only send images on explicit `read_compacted_history` calls.
- Archive data can become stale if sourced from an out-of-date card snapshot; derive it immediately before the request is sent.
- If archive recall setup fails, the run should continue without the MCP server instead of failing the whole chat.
