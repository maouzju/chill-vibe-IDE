# Security Policy

## Local-First Threat Model

Chill Vibe is built for local use on a trusted machine.

- The local HTTP server binds to `127.0.0.1` by default.
- The app can launch local provider CLIs inside user-selected workspaces.
- Provider subprocesses inherit the current process environment.
- The repository does not ship built-in multi-user auth, tenant isolation, or remote access controls.

## Safe Defaults

- Keep the server on loopback unless you intentionally know why you need otherwise.
- Do not expose the HTTP API directly to a LAN or the public internet without adding authentication and transport security.
- Treat prompts, workspace paths, and local logs as sensitive project data.
- Avoid running the app in shells that hold secrets you would not want child processes to inherit.

## Reporting A Vulnerability

If you discover a vulnerability that could impact users, please avoid posting full exploit details in a public issue first.

This repository does not currently publish a dedicated security email address in-tree.
Private GitHub reporting is the preferred path when it is enabled for the repository:

- Security page: `https://github.com/maouzju/chill-vibe-IDE/security`
- Advisory submission flow: `https://github.com/maouzju/chill-vibe-IDE/security/advisories/new`

Preferred process:

1. Use GitHub private vulnerability reporting if the repository exposes the `Report a vulnerability` flow.
2. Include affected version, reproduction steps, impact, and any suggested mitigation.
3. If the private advisory flow is unavailable, open a limited public issue without exploit details and ask for a secure follow-up path.

## Out Of Scope

The following are not currently treated as supported secure deployment targets:

- publicly exposed servers
- shared multi-user hosts
- enterprise remote execution environments without additional hardening
