# Contributing to OmniConsole

Thanks for helping build OmniConsole ([omnirogue/omniconsole](https://github.com/omnirogue/omniconsole)),
the open-source multi-agent IDE. Code, documentation, accessibility improvements, translations
and reproducible bug reports are all welcome. The [Code of Conduct](CODE_OF_CONDUCT.md) applies
to every OmniConsole and OmniSI community space.

OmniConsole is one of four projects in the OmniSI Open-Source Suite. If your change belongs in a
sibling project, open it there:

| Project | Repository | What it owns |
| --- | --- | --- |
| OmniConsole | [omnirogue/omniconsole](https://github.com/omnirogue/omniconsole) | The desktop IDE, the `omni` CLI and the mobile companion. |
| OmniSeek | [omnirogue/omniseek](https://github.com/omnirogue/omniseek) | Codebase discovery and citation grounding (`omniseek`, `omniseek-mcp`). |
| OmniEvolve | [omnirogue/omnievolve](https://github.com/omnirogue/omnievolve) | Evolutionary code and prompt optimization (`omnievolve`, `omnievolve-mcp`). |
| JevLab | [omnirogue/jevlab](https://github.com/omnirogue/jevlab) | LLM-as-judge calibration and bias diagnostics (`jevlab`, `jevlab-mcp`). |

## Before you start

Search existing [issues](https://github.com/omnirogue/omniconsole/issues) and pull requests
first. A small, focused fix is a good first contribution. Discuss changes to architecture,
authentication, billing or public APIs in an issue before building them; include the problem,
an example and the behavior you propose. A discussion does not require an OmniSI account.

Report vulnerabilities privately through the [security policy](SECURITY.md), never in a public
issue. Remove credentials, customer information, private hostnames and personal paths from
logs and screenshots you post.

## Development setup

Use Git, **Node.js 24** and **pnpm 12**; the exact pnpm version is pinned by `packageManager`
in [package.json](../package.json). Native dependencies need your platform's compiler
toolchain: Xcode Command Line Tools on macOS, C/C++ build tools on Linux, or Visual Studio Build
Tools on Windows.

Fork the repository, then:

```sh
git clone https://github.com/YOUR-USERNAME/omniconsole.git
cd omniconsole
git remote add upstream https://github.com/omnirogue/omniconsole.git
git switch -c fix/describe-your-change
pnpm install --frozen-lockfile
pnpm dev
```

Do not regenerate the lockfile to work around a package-manager mismatch; install the pinned
version instead. Keep credentials outside the checkout. Hosted integrations need your own
account; use fixtures for development that does not need a real service.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the Electron development app. |
| `pnpm dev:web` | Start the web renderer development server. |
| `pnpm tc` | Typecheck the main, CLI and renderer projects. |
| `pnpm tc:node`, `pnpm tc:cli`, `pnpm tc:web` | Typecheck one boundary. |
| `pnpm run check:code-quality:changed` | Code-quality checks for changed files. |
| `pnpm exec oxlint path/to/file.ts` | Lint specific files. |
| `pnpm exec oxfmt --write path/to/file.ts` | Format specific files. |
| `pnpm test path/to/file.test.ts` | Run the relevant Vitest tests. |
| `pnpm build` | Typecheck and build the desktop app and native components. |
| `pnpm build:mac`, `pnpm build:win`, `pnpm build:linux` | Build a platform package. |

`pnpm format` rewrites the whole repository; for a focused patch, format only the files you
changed. Packaging a local build does not sign, publish or release it.

## Architecture map

| Directory | Responsibility |
| --- | --- |
| `src/main/` | Electron main process: persistence, credentials, providers, IPC and desktop integration. |
| `src/main/runtime/` | Execution services, workflows, sessions and RPC handlers. |
| `src/preload/` | Typed bridge between privileged services and the renderer. |
| `src/renderer/src/` | React interface, state and components. |
| `src/shared/` | Cross-boundary types, schemas and portable domain code. |
| `src/cli/` | The `omni` CLI: command specifications and handlers. |
| `src/relay/` | Remote execution and relay integration. |
| `mobile/` | Mobile companion app. |
| `config/`, `config/scripts/` | Build, typecheck, lint and verification tooling. |
| `tests/` | Integration and end-to-end tests; unit tests live beside their source. |
| `docs/`, `skills/`, `skill-guides/` | Reference documentation and bundled agent guidance. |

Keep renderer code behind the preload API, and validate untrusted input wherever it crosses an
IPC, RPC, network or process boundary.

## Engineering rules

- **Cross-platform.** OmniConsole targets macOS, Linux and Windows. Guard platform-specific
  behavior with runtime checks. Use `CmdOrCtrl` for Electron accelerators, show `⌘`/`⇧` on macOS
  and `Ctrl+`/`Shift+` elsewhere, and build paths with `path.join` or Electron path utilities.
- **Local, SSH and WSL.** Never assume a process, file, credential, shell or network path exists
  only on the local machine. The execution host owns its processes, filesystem and provider
  authentication; a disconnected host has unknown status, not stopped processes.
- **Mixed versions.** Clients and remote hosts update independently. A new optional field is
  safe; negotiate a capability before depending on new behavior.
- **Folders and worktrees.** Changes must work in folder workspaces as well as Git worktrees.
- **Provider-neutral.** OmniConsole supports many agents, integrations and Git providers
  (GitHub, GitLab and others). Keep generic behavior generic and guard provider-specific logic
  behind explicit checks. Never silently switch a person's account or model.
- **Performance.** Follow the existing architecture, avoid work in hot paths and clean up the
  resources you own.

See [AGENTS.md](../AGENTS.md) and [`docs/reference/`](../docs/reference/) for the detailed
contracts behind these rules.

## Code style

Follow the existing TypeScript and React conventions, `oxlint` and `oxfmt`. Prefer small
modules named for their domain responsibility; never `utils`, `helpers` or `misc`. Comments
explain non-obvious reasons, not what the code does.

The [oxlint configuration](../.oxlintrc.json) caps nonblank, noncomment lines per file:

| File type | Maximum |
| --- | ---: |
| `.ts` | 300 |
| `.tsx` | 400 |
| `.mjs` | 600 |
| `.test.ts`, `.test.tsx`, `.spec.ts`, `.spec.tsx` | 800 |

Split cohesive responsibilities before reaching the limit. Do not disable `max-lines` or raise a
per-file limit to make a patch pass.

For UI work, follow the [style guide](../docs/STYLEGUIDE.md), its design tokens and the shadcn
primitives it names. Check keyboard access, focus behavior, light and dark appearance, small
windows and SSH latency.

## Type Declarations: Prefer `.ts` Over `.d.ts`

Project-owned type declarations belong in `.ts` files. `.d.ts` is reserved for ambient shims
(for example `env.d.ts`). TypeScript's `skipLibCheck: true` applies to our own `.d.ts` files
too, so an unresolved type reference in one silently becomes `any` at its call sites. CI enforces
this for `src/preload/` and `src/shared/`.

## Pull requests

1. Branch from `main` with a descriptive name, such as `fix/ctrl-backspace-delete-word` or
   `feat/shift-enter-newline` (not `test` or `changes`).
2. Keep the change focused on one topic. Explain dependency or generated-file changes, avoid
   unrelated reformatting and preserve other contributors' work.
3. Add tests that would catch a regression when behavior changes: failures, cancellation,
   retries and remote behavior where relevant, not only the happy path. Documentation-only
   edits need link, example and formatting checks rather than a full test run.
4. Run the relevant commands above, then the public-tree marker check:
   `bash scripts/export_oss_omniconsole.sh --check`.
5. Review `git diff --check` and `git status --short`, stage explicit paths and open a pull
   request with the [PR template](pull_request_template.md): a plain-language summary, what
   changed and why, before/after screenshots for UI changes (or `No visual change` and why),
   and platform, SSH, agent, Git-provider, security and performance notes.
6. Include your GitHub or X handle in the template's Author section so we can credit you.
7. Address review comments and let the required checks pass. Maintainers merge and release;
   version bumps and tags are maintainer-managed, so leave them out of normal contributions.

AI-assisted contributions follow the same process. The person submitting remains responsible
for understanding the patch, its provenance and its verification. Do not present generated
tests, simulated services or commands you did not run as live verification.

### Re-testing a repaired base

`gh run rerun` replays the merge commit and event payload GitHub froze when the run started, so
it cannot see a fix pushed to the base branch or a label added since. To get a fresh run, either
close and reopen the PR (`gh pr close <N> && gh pr reopen <N>`), or update the branch with
`gh api -X PUT repos/omnirogue/omniconsole/pulls/<N>/update-branch`.

Label a PR `ci:no-fail-fast` to run every test shard to the end instead of stopping at the first
failure. Apply the label before the push or reopen that starts the run.

## License

OmniConsole is released under the [MIT License](../LICENSE). By submitting a contribution you
agree that it is licensed under the same MIT License, and you confirm that you wrote it or
otherwise have the right to submit it. Keep the copyright, license and attribution notices of
any third-party material you include, and name its source in the PR. Contributing does not
grant rights to project trademarks.

## Product documentation

- [The OmniSI Open-Source Suite](../docs/oss/OMNISI-OSS-ECOSYSTEM.md)
- [Connect an OmniRogue account and choose a Primary AI](../docs/oss/OMNIROGUE-CONNECTOR-GUIDE.md)
- [Local and hosted Evolve](../docs/oss/HOSTED-EVOLVE-SUPER-INTELLIGENCE.md)
- [Unified MCP reference](../docs/oss/UNIFIED-MCP-REFERENCE.md)
