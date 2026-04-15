# Contributing to Chill Vibe

Thanks for your interest in contributing! Here's how to get started.

## Prerequisites

- Node.js >= 20
- pnpm

## Setup

```bash
pnpm install
pnpm dev
```

## Development Workflow

1. Fork the repo and create a feature branch from `main`.
2. Read [`AGENTS.md`](./AGENTS.md) — it defines the TDD workflow and tier rules that govern all changes.
3. Make your changes following the tier rules:
   - **Tier 1 (logic):** Write a failing test first, then implement.
   - **Tier 2 (style):** Include visual regression snapshots.
4. If you change dependencies or third-party asset sources, run `pnpm legal:generate` and update [`THIRD_PARTY.md`](./THIRD_PARTY.md) as needed.
5. Run the full verification suite before submitting:

```bash
pnpm legal:check
pnpm verify
```

## Pull Requests

- Keep PRs focused — one concern per PR.
- Include a clear description of what changed and why.
- Refresh generated legal docs when dependency or third-party source changes require it.
- Ensure all checks pass (`pnpm verify`).

## Reporting Issues

Use [GitHub Issues](https://github.com/maouzju/chill-vibe-IDE/issues). Include reproduction steps, expected vs actual behavior, and your environment.

## License

By contributing you agree that your contributions will be licensed under the [MIT License](./LICENSE).
