# Work contract admission

`terminal.createAgentSession` checks what an unattended launch must deliver before the runtime creates any terminal or session. It exists because on 17 Oct 2026 a script called this RPC directly 364 times with briefs whose only done check was "write a Markdown file of 150+ lines", so software builds silently became documents.

The OmniOS BFF (`bff/omni_bff/work_contract.py` in omnirogue/omni-console) is the authority for human decisions. This runtime gate only makes the direct RPC path converge on it. Code: `src/shared/work-contract-admission.ts`, `src/shared/work-contract-v2-schema.ts`, `src/main/runtime/rpc/methods/agent-session-work-admission.ts`.

## Classification

Only transport facts count; a caller-supplied `launchCause` (for example `trigger: "interactive"`) never changes the result.

| Classification | When                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `hub_admitted` | `managedToolsFile` names a host-owned descriptor that validates for this `clientOperationId` and agent. The BFF already ran contract admission. |
| `interactive`  | The caller is the mobile actor (the person lane), or the launch neither auto-submits a prompt nor is `presentation: "background"`.              |
| `unattended`   | A non-empty prompt is auto-submitted (`promptDelivery` omitted or `auto-submit`), or `presentation` is `background`.                            |

Paired desktop windows that launch on a remote runtime also send `presentation: "background"` with an auto-submitted prompt, so they classify as `unattended`. Keep this in mind before turning on `enforce`.

## Contract

An optional `workContract` parameter (at most 64 KB of JSON) carries a v2 contract in the BFF's snake_case shape. Shape and consistency rules mirror the BFF's `parse_contract` and `consistency_problems`. The runtime cannot check `authority`: a direct-RPC contract is recorded with `authorityVerified: false`.

## Modes

`OMNI_WORK_CONTRACT_ADMISSION` in the app's environment: `off`, `shadow` (default) or `enforce`.

- `off`: contracts are ignored and every launch is admitted.
- `shadow`: every launch is admitted, except one carrying a defective contract. `result.workAdmission.status` is `uncontracted` or `contracted` for unattended launches so they can be counted.
- `enforce`: also refuses every unattended launch that is not `hub_admitted`, with or without a contract, and points the caller to OmniOS (`launch_ai_sessions_batch` or a work run).

Turning on `enforce` is a separate rollout decision.

## Result and refusals

A successful result carries `workAdmission`: `status` (`interactive`, `hub_admitted`, `contracted` or `uncontracted`), `mode`, and for a contract `contractDigest`, `workRef`, `deliverableKind`. `contractDigest` is the runtime's own sha256 over the normalized contract as sorted-key compact JSON. It may differ from the BFF digest (Python renders floats such as `5.0`).

Refusals start nothing and carry `data.workAdmission`:

| Code                                                                                                                                                                                                     | Meaning                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `work_contract_required`                                                                                                                                                                                 | `enforce`: an unattended launch did not come through OmniOS.                                                        |
| `invalid_work_contract`                                                                                                                                                                                  | The contract fails the v2 schema; the message names the field.                                                      |
| `deliverable_downgrade`, `deliverable_mismatch`, `acceptance_kind_mismatch`, `target_required`, `no_implementation_workspace`, `check_subject_mismatch`, `line_count_acceptance`, `needs_classification` | The contract contradicts itself; the code is its first problem and `data.workAdmission.problems` lists all of them. |

A supplied `workContract` is part of the operation's replay fingerprint, so replaying an operation ID with a different contract fails with `agent_session_operation_conflict`.
