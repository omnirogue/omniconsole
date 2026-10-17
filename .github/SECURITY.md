# Security Policy

## Supported versions

Security fixes land on `main` and ship in the next release on
[GitHub Releases](https://github.com/omnirogue/omniconsole/releases).

| Version | Supported |
| ------- | --------- |
| Latest release and `main` | :white_check_mark: |
| Older releases | :x: |

## Reporting a vulnerability

Please **do not** report vulnerabilities in public issues, discussions or pull requests.
Report them privately:

1. **GitHub Security Advisories (preferred):** open a private advisory at
   [github.com/omnirogue/omniconsole/security/advisories/new](https://github.com/omnirogue/omniconsole/security/advisories/new).
2. **Email:** write to **security@omnirogue.com**.

Include the affected component (Electron main process, preload bridge, renderer, CLI, SSH or
relay, mobile companion, or an MCP integration), steps to reproduce or a minimal proof of
concept, the impact you expect, and any mitigation you suggest. Remove real credentials,
customer data, private hostnames and personal paths from what you send.

## Scope

This policy covers the code in this repository. Report issues in OmniSeek, OmniEvolve or JevLab
through the security policy of [their own repositories](https://github.com/omnirogue). For OmniSI
Cloud or other OmniRogue hosted services, email **security@omnirogue.com**; do not test hosted
services in ways that affect other customers, degrade availability or access data that is not
yours.

## Response

- **Acknowledgment:** within 48 hours.
- **Triage and status update:** within 5 business days.
- **Fix and disclosure:** once a fix is released, we coordinate public disclosure with you and
  credit you unless you prefer to stay anonymous.

## Security model

- **Credentials** stay on your machine: in the OS keychain (`safeStorage`) or user-scoped `0600`
  files, never in logs or commits. Each agent CLI keeps its own provider sign-in.
- **Process isolation:** renderer views run with context isolation and reach the main process
  only through typed preload IPC (`src/preload/`).
- **Execution:** agents, terminals and MCP servers run with the permissions of your user on the
  host that executes them, local or remote. Connect only workspaces, SSH hosts and MCP servers
  you trust.
