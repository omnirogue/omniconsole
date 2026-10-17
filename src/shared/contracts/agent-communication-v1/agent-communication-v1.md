# Agent communication capability contract v1

This is the canonical public capability contract shared by OmniConsole, OmniRogue, and the internal hub. It is a small compatibility surface on their existing APIs. It creates no broker, queue, scheduler, actor identity or permission grant.

Canonical files:

- `docs/contracts/agent-communication-v1.schema.json`: JSON Schema draft 2020-12.
- `docs/contracts/agent-communication-v1.fixtures.json`: shared valid/invalid vectors.
- This specification: meaning and adoption rules that a shape validator cannot establish.

The existing OmniRogue release manifest and the hub pending response place the schema instance in a `communication` property. The schema validates the value of that property, not either product's entire response. The desktop's real account/release path consumes it. The schema `$id` is an identifier; validation must use the pinned local schema and must not fetch a remote schema at runtime.

## Shape and meaning

```json
{
  "schema_version": 1,
  "scope": "deployment_capabilities",
  "channels": [
    {
      "kind": "human_chat",
      "implementation": "implemented",
      "feature_enabled": true,
      "receive_mode": "cursor_poll",
      "wake_mode": "none",
      "lease_ack": false,
      "model_ack": false,
      "reply_correlation": false,
      "task_incorporation": false
    },
    {
      "kind": "agent_exchange",
      "implementation": "not_implemented",
      "feature_enabled": false,
      "receive_mode": "none",
      "wake_mode": "none",
      "lease_ack": false,
      "model_ack": false,
      "reply_correlation": false,
      "task_incorporation": false
    },
    {
      "kind": "managed_job",
      "implementation": "not_implemented",
      "feature_enabled": false,
      "receive_mode": "none",
      "wake_mode": "none",
      "lease_ack": false,
      "model_ack": false,
      "reply_correlation": false,
      "task_incorporation": false
    }
  ]
}
```

This is a shape example for human room support, not evidence about any current deployment. All properties are required. Objects reject extra fields. `channels` contains exactly one of each kind; consumers must select by `kind`, not array position.

| Field                | Meaning                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`     | Exact integer `1`. Do not coerce a string or accept an unknown future version.                                                                                                                                                                                                                                                                                                                      |
| `scope`              | Always `deployment_capabilities`. This response never establishes individual runtime readiness.                                                                                                                                                                                                                                                                                                     |
| `kind`               | `human_chat`: authenticated human communication. `agent_exchange`: addressed model/session communication. `managed_job`: communication consumed by an existing authorized persisted run, with continuation in that same run/task. A managed run may use API models without a native terminal. An unrelated draft generator or a newly launched substitute job is not this communication capability. |
| `implementation`     | `implemented`, `not_implemented`, or `unknown`, describing code support for the channel contract. An inactive business-specific workflow may exist without implementing generic managed-run communication.                                                                                                                                                                                          |
| `feature_enabled`    | Boolean operator feature configuration; `null` means not observed or not applicable. This is independent of code support. `true` does not prove deployment health, migrations, entitlement, credentials, a live receiver or a binding.                                                                                                                                                              |
| `receive_mode`       | `none`; `explicit_pull` for an explicit recipient inbox call; `cursor_poll` for ordered event reads; `managed_resume` for intake within the existing persisted run continuation. This field describes the supported interface even when its feature flag is disabled.                                                                                                                               |
| `wake_mode`          | `none`; `native_prompt` for an implemented automatic exact-session prompt adapter; `managed_resume` for an implemented existing-run wake adapter. A manual tool call capable of submitting a prompt does not establish automatic wake.                                                                                                                                                              |
| `lease_ack`          | A recipient lease has a distinct explicit settlement operation. It is transport evidence, not a model receipt.                                                                                                                                                                                                                                                                                      |
| `model_ack`          | The channel implements a structured model-owned acknowledgment distinguishable from a renderer, observer, script or transport acknowledgment. It does not assert that any particular model has acknowledged anything.                                                                                                                                                                               |
| `reply_correlation`  | The reply is bound to its original request and return destination. Freeform text that mentions a task does not establish this capability.                                                                                                                                                                                                                                                           |
| `task_incorporation` | The channel requires and validates correlated evidence of the returned result's use by the original task/run. A `resolved` flag or comparison of two stored checksum strings alone is insufficient.                                                                                                                                                                                                 |

When `implementation` is `not_implemented` or `unknown`, both modes must be `none` and all acknowledgment/correlation/incorporation booleans must be false. A producer must not infer support from a feature flag. Capability support can remain true while `feature_enabled` is false, because this preserves the difference between code and configuration.

An implemented channel with a true feature flag is still only **supported and enabled**. Native identity, task authority, binding generation, active lease, inbox contents, receipt evidence and per-session health remain in the existing authenticated product APIs. Do not put them or credentials, customer content, endpoint IDs, tenant IDs or access grants in this public contract.

## Current adoption boundaries

- Hub peer communication maps to `agent_exchange`, `explicit_pull`, `wake_mode: none`, `lease_ack: true`, `reply_correlation: true`, `model_ack: false`, `task_incorporation: false`. Its current lease ACK and resolve operations do not enforce semantic model receipt or incorporation evidence. Human chat and generic managed-job communication are not implemented by that peer endpoint.
- OmniRogue's paid-core room implementation maps to `human_chat` and `cursor_poll`, with no model acknowledgment, idle wake, correlated agent reply or original-task return. Its proposal/contract workflow code is a separate business workflow; a staged/disabled draft worker must not be advertised as generic bot communication.
- OmniConsole desktop can display server capabilities before it has a receiver adapter. It must explicitly distinguish server support from its own lack of remote agent inbox consumption. The Electron local queue driver is not a remote inbox or idle external-session wake.
- The IDE's manual `terminal send --enter` can start a native turn, but the hub must keep `wake_mode: none` until an automatic adapter exists, targets the enrolled original session and is enabled through its supported configuration.

These mappings are source-defined adoption expectations. Per-deployment flags are supplied by the owning service; a successful API call alone does not prove actual agent delivery.

## Conservative parsing and upgrade behavior

Missing `communication`, malformed JSON/object shape, any unknown version/field/enum, duplicate or missing channel kinds, and contradictory unsupported claims invalidate the whole capability document. The consumer reports communication support as **unknown/not confirmed** and grants no capability. It must not silently convert an absent version into version 1, ignore a malformed channel, infer support from room access, or reuse an earlier optimistic response after current validation fails.

The canonical `known_schema_unknown_capabilities` fixture is a valid representation of an explicit unknown result. Invalid input is not rewritten into factual `not_implemented` evidence: unknown and verified absence are different findings. Independent account information can remain usable when this optional capability field is missing or invalid.

Version 1 is closed. New fields or modes require a new contract version or a deliberately coordinated v1 amendment with all consumers updated before producers. A future adapter must implement the semantics before advertising its capability; passing the future-shape fixture is not delivery proof. No capability response enables scopes, starts workers or enrolls a session.

## Shared fixtures and provenance

Fixture file format is `{ "fixture_version": 1, "cases": [{ "name": "...", "valid": true, "input": {} }] }`. `input` is the communication value, and `valid` is JSON Schema validity. Every producer/consumer test must exercise the same cases. The fixture named `future_adapter_capabilities_shape_only_not_deployment_evidence` validates an upgrade shape only; it is not a claim that the depicted adapter exists.

The source of truth is `omnirogue/omniconsole` under `docs/contracts`. Backend and hub vendor these exact schema, fixture and specification bytes. Their vendor manifest records the canonical repository, source commit, relative paths and SHA-256 for each file. Verify digests during tests or release checks; edit the canonical source first, then synchronize consumers. Do not independently author a second schema or alter a vendored fixture to make a divergent parser pass.

Schema/fixture agreement proves compatibility only. The acceptance criterion for actual collaboration remains an original-session or original-run request, recipient-model acknowledgment, correlated return, original-task incorporation, and separately observed unattended receive behavior in both directions.
