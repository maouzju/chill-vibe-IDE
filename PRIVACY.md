# Privacy Notes

Chill Vibe is a local-first application. It does not include built-in cloud sync or a hosted backend.

## What The App Stores Locally

The app persists local data in:

```text
.chill-vibe/
```

By default that path is resolved from the current working directory.
Set `CHILL_VIBE_DATA_DIR` if you want state to live outside a repository checkout or any other directory that might be shared, archived, or published.

Local files in that directory may contain:

- workspace paths
- chat history
- session identifiers returned by provider CLIs
- provider profile settings, including configured base URLs and API keys
- layout preferences
- UI settings
- experimental feature state such as music session cookies, playback stats, white-noise scenes, and cached ambient audio

## What The App Sends

The app can send your prompts to whichever local provider CLI you run through it, such as `codex` or `claude`.

Those tools may have their own network behavior, logging, retention, and privacy policies. Review the provider you are using before sending sensitive material.

Some optional experimental features can also contact third-party services directly, including weather providers, music services, and sample-audio hosts used for ambient playback.

## Environment Variables

Provider subprocesses inherit the current process environment by default.

That means secrets available in the shell that launched Chill Vibe may also be visible to child processes started by the app.

## Operational Advice

- Use the app on machines you trust.
- When running from a git checkout, move `CHILL_VIBE_DATA_DIR` outside the repository if you do not want API keys, cookies, and chat history stored beside your source files.
- `.gitignore` excludes `.chill-vibe/`, but that only reduces accidental commits. It does not encrypt, redact, or otherwise protect the contents.
- Keep sensitive repositories and prompts on local-only setups unless you understand the provider path end to end.
- Clear local state if you no longer want previous chat history, API keys, cookies, or workspace metadata retained.
