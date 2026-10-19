---
name: omni-boundary-review
description: Review a specified Electron or remote-agent change for IPC trust, execution-host ownership, identity, lifecycle and mixed-version compatibility defects. Use for a requested boundary-focused review, not every frontend or TypeScript edit.
---

# Electron and remote boundary review

Trace who may request an operation, which host owns it, and what evidence proves
its result. Use this focused role for the requested boundary change; no extra
agent, persistent monitor or automatic review loop is implied. Findings only
unless the user also authorized fixes.

## Bind the review

Read this project's AGENTS.md and relevant architecture docs. Establish the
actual PR base/head, uncommitted diff or requested files. Record the source and
owning host; missing remote access means unverified, not exited or absent.
Do not create a worktree just to read a change or assume every workspace is Git.

In main-next, consult the relevant existing references rather than inventing a
parallel contract: `docs/reference/ssh-execution-boundary.md`,
`remote-wire-compatibility.md`, `outcome-continuation-relaunch.md`,
`windows-setup-shell.md` and `wsl-command-execution.md` under that same directory.
Read only those implicated by the change. If reviewing another repository,
use its actual contracts and clearly identify missing guidance.

## Trace the changed operation end to end

- **Renderer to main/host:** establish caller identity, schema validation, capability
  and authorization at the effect boundary. Renderer state or a disabled button
  alone is not an authorization fence. Review preload exposure and navigation or
  external-URL handling when affected.
- **Execution owner:** use the host that owns the session/process/files/credentials.
  Recheck owner and principal after relevant awaits. A disconnected stream cannot
  prove process death; retain the live / unverifiable / exited distinction.
- **Mutation result:** preserve idempotency and reconcile uncertain execution before
  retry. A model answer, transcript summary or worker message cannot replace the
  authoritative effect receipt or grant permission for another action.
- **Remote compatibility:** older clients and hosts remain possible. Check optional
  fields, capability negotiation for new behavior, and what an older peer sees.
  Receiving no event must not be mistaken for successful cleanup or completion.
- **Processes and paths:** follow existing child-process, Windows, WSL and containment
  helpers. Look for unsafe shell interpolation, client paths used on a remote host,
  symlink escapes or leakage of secrets into prompts/logs/renderer state.
- **Lifetime and continuation:** inspect cancellation, shutdown, reconnect and
  durable recovery. Closing a UI must not accidentally kill unrelated execution;
  preserving a process must not silently broaden its authority or launch arguments.
- **Plugins and typed decisions:** keep source integrity, publisher trust, user
  consent and semantic safety distinct. Advisory confidence is not a probability
  of correctness, approval, or permission to bypass deterministic validation.

Prioritize a concrete reachable failure over a hypothetical checklist concern.
For each finding cite the source location, crossing/identity involved, trigger,
impact and minimal correction. End with unverified boundaries and existing CI
status. No findings is a bounded review result, not a security certification.

## Use and verification

Example: “Use $omni-boundary-review on this SSH dispatch change; check reconnect,
owner changes and compatibility with the previous runtime. Findings only.”

Use the current agent unless a separate reviewer was requested. A separate
reviewer receives the same source/host scope and this skill; use the installed
orchestration guide when supervising and returning its results. This prompt
never chooses a model or launches workers on its own.

Follow project verification policy. For Sal's main-next, required GitHub checks
remain the test/merge authority. No local/fleet suites or additional merge gates.
A requested bounded live/preflight check must preserve existing sessions and
side-effect limits. Use the repository's prescribed Electron/CDP workflow for
rendered UI verification; source inspection alone is not a live UI result.

## Attribution

Type-boundary/security review framing adapted from ECC
`agents/typescript-reviewer.md` at `bf70150eb2df8070024e5bdf08e4aa08959e2735`:
https://github.com/affaan-m/ECC/blob/bf70150eb2df8070024e5bdf08e4aa08959e2735/agents/typescript-reviewer.md
Electron/host guidance specializes the existing main-next project contracts.
The installed package includes the upstream [MIT license](LICENSE).
