---
name: omni-typescript-review
description: Review a specified TypeScript or JavaScript diff for concrete correctness, type-boundary and async-lifecycle defects. Use when a code review is requested; reports findings without requiring another agent or making every code change trigger a review.
---

# TypeScript review

Review the requested change, not the entire codebase. A specialized reviewer is
a normal agent given this scope and checklist; it is not a new model or a
mandatory merge gate. Report findings; edit only if fixes were also requested.

## Establish the exact source

Read project instructions. For a PR, obtain its actual base and head; do not
assume main or substitute a local branch. For uncommitted work, include staged,
unstaged and relevant untracked files. State the inspected commits/files and
any missing context. Read callers and existing source tests where necessary to
establish reachability, intent and coverage; do not run a suite just to review.
A folder workspace can have a file-scoped review without Git history.

Read required GitHub check results when available and label them separately
from source findings. Pending CI does not prevent source inspection, and green
CI is not proof that a source concern is impossible. In this repository, do not
run local/fleet test suites or introduce extra mandatory review gates.

## Follow the data and lifecycle

Concentrate on changed behavior and relevant surrounding code:

- External data crossing `unknown`/schema boundaries: casts and non-null assertions
  that claim checks which never ran; changed unions that leave a reachable case
  unhandled; optional wire fields whose absence older peers can still produce.
- Async ownership: stale responses publishing after selection/account/host changes,
  cancellation after awaited work, retries repeating an uncertain mutation, and
  promises whose failures escape the intended error path.
- Shared state and event lifetime: listeners or resources retained after disposal,
  updates racing with cleanup, and a cache carrying one identity's data into another.
- Error paths: failures swallowed while success is reported, useful cause/context
  lost, or partial results represented as complete. Check existing error handling
  before proposing another blanket try/catch.
- Trust boundaries: user-controlled paths, process arguments, HTML, dynamic code,
  secrets in output, and privilege reachable through a validated-looking type.
- React only where changed: effect cleanup and stale closures, identity-dependent
  state, and unstable list identity that changes actual behavior. Do not request
  memoization, annotations or stylistic rewrites without a demonstrated problem.

Do not treat every sequential await as a defect: ordering may enforce authority
or idempotency. Do not prescribe generic path-prefix checks; follow the existing
containment and cross-platform helpers. Read the project's boundary guidance
when the diff touches Electron, SSH, WSL or paired-host execution.

## Findings

Lead with actionable findings, ordered by impact. For each give the affected
file/line, concrete trigger, resulting failure, supporting code path and a
minimal correction direction. Separate demonstrated defects from unanswered
questions; do not inflate speculative risks into blockers.

Then state the inspected scope, CI status and verification limits. If no
material defects were found, say that and describe the limits. An advisory
review does not grant merge/deployment authority or establish task completion.
For a requested recheck, inspect the changed evidence and close once resolved;
this skill does not create an automatic review loop.

## Invocation examples

“Use $omni-typescript-review on this PR against its actual base. Findings only.”

“Have a separate reviewer use $omni-typescript-review on this diff and return
its findings here.”

The first runs in this conversation. The second explicitly requests another
agent: supply its exact workspace/host, PR or file scope, this skill and the
required result. Follow the installed orchestration guide for supervision and
return delivery; for a full ownership handoff, use omni-cli instead. Keep any
requested model selection. Do not claim independence when the author performs
its own review in the same conversation.

## Attribution

Adapted from ECC `agents/typescript-reviewer.md`, pinned at
`bf70150eb2df8070024e5bdf08e4aa08959e2735`:
https://github.com/affaan-m/ECC/blob/bf70150eb2df8070024e5bdf08e4aa08959e2735/agents/typescript-reviewer.md
The installed package includes the upstream [MIT license](LICENSE).
