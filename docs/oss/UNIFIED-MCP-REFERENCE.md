# Unified MCP reference

This reference covers the OmniSI and OmniRogue tool catalogs inspected on
**2026-10-16**, including optional tool families and the integration-stage Wave 4
batch/receipt contract. It is a source-backed catalog, **not an authenticated
production inventory**. The deployed server's `tools/list` and returned schemas
are authoritative for your connection. Do not call an optional tool until it is
listed. Model availability, prices, feature flags, and account permissions vary.

## Endpoints and authentication

| HTTPS endpoint | Surface |
| --- | --- |
| `https://app.omnisi.ai/mcp` | Unified credits and media adapters, Super Intelligence, Decisions, Pages, sessions, relay, marketplace, and shared tools. |
| `https://api.omnirogue.com/mcp` | Direct media catalog and generation, image/video workflows, Voice Studio, creative skills, and account-authorized work/session controls. |

Use an MCP client with Streamable HTTP and the endpoint's supported OAuth or
bearer-token flow. OmniConsole provisions supported connectors after account
linking; see the [connector guide](OMNIROGUE-CONNECTOR-GUIDE.md). In another client,
add the exact URL, follow the server's authorization challenge, and keep the
credential in the client's secure configuration. Do not put tokens in URL query
strings, source files, or prompts.

OmniSI and OmniRogue are distinct protected resources. A login or token accepted
by one does not independently prove authorization at the other. A linked
OmniRogue account supplies the identity used by unified wallet operations.
Caller-supplied organization/person IDs cannot replace the authenticated identity.

On the direct OmniRogue endpoint, media tools use scopes such as `models:read`,
`credits:read`, `generations:read`, and `generations:write`. Work and session tools
use their separately advertised scopes. Inspect `securitySchemes` and any
`mcp/www_authenticate` challenge. Account-authorized access and direct API keys
can use different balances; read the tool's returned billing source.

## MCP messages, discovery, and errors

Let your MCP client negotiate `initialize` and send `notifications/initialized`.
Use the negotiated protocol version and session headers where returned. A raw
JSON-RPC tool listing is:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

Follow `nextCursor` with `params.cursor` if the server paginates. Save each tool's
`name`, `description`, `inputSchema`, optional `outputSchema`, annotations, and
security metadata. This retrieves the complete catalog for that connection,
including tools added after this document's snapshot.

Call a tool using its exact advertised name:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "credits_balance",
    "arguments": {"include_details": false}
  }
}
```

Tool results may contain `structuredContent` and JSON or text in `content`.
Check `isError` as well as the JSON-RPC/HTTP result. HTTP 200 alone does not prove
success. Annotations such as `readOnlyHint` and `idempotentHint` describe intended
behavior; they do not grant permission to spend or communicate.

Do not blindly retry writes on a timeout. Recover the original request/run ID or
reuse the documented idempotency key with identical input. Handle 401 by
reauthorizing the correct resource, 403 by checking permissions, 429 by honoring
backoff, and invalid-argument errors by refreshing the schema. Unknown outcomes
require reconciliation, not a replacement paid request.

### Progressive discovery with `include_details`

On OmniSI, `tools_search` accepts `query` (default empty), `namespace`, `limit`
(1–100, default 20), and `include_details` (default false). Search keywords or
patterns such as `media.*`, `credits`, or `evolve`. Namespaces include `media`,
`si`, `credits`, `pages`, `decisions`, and `all`.

```json
{"query":"media.*","limit":20,"include_details":false}
```

Then retrieve schemas for the relevant family:

```json
{"namespace":"media","limit":100,"include_details":true}
```

Concise mode limits descriptions and metadata. Detailed mode includes full input
schemas and annotations. It changes response detail, not permissions, spend,
or whether a write executes. A detailed `media_generate` call still generates.
Use `tools/list` pagination for exhaustive discovery; a limited search is not a
complete catalog. The direct OmniRogue tools do not generally accept
`include_details`; use their discovery tools and schemas instead.

## OmniSI unified credits and media

These tools are on **app.omnisi.ai/mcp**. All nine base unified tools accept
`include_details`. Unless explicitly shown as required, fields are optional;
conditional requirements still apply. Extra properties are rejected by most of
these schemas.

| Tool | Inputs and limits | Result and effects |
| --- | --- | --- |
| `tools_search` | `query`, `namespace`, `limit`, `include_details`; see above. | Read-only discovery; detailed results include schemas. |
| `credits_balance` | `include_details`. | Spendable/total credits and plan tier; details add reservations and linked identity. No spend. |
| `credits_quote` | Supply `sku` or alias `operation`; `units` integer ≥1, default 1; optional `model`, `metadata`, details. | Server-calculated `quote_id`, `estimated_credits`, `max_credits`; details add unit/currency metadata. Quoting does not generate. |
| `media_generate` | Required `prompt`; `kind` = `image` (default), `video`, or `audio`; alias `media_type`; optional `model`, `aspect_ratio`, `duration_seconds`, `parameters`, `idempotency_key`, `reservation_id`, details. | Submit media work, returning a request ID and status. May spend credits. |
| `media_edit` | Required `image_url`, `prompt`; `edit_mode` default `inpaint`; `kind` = `image` (default) or `video`; optional `model`, `mask_url`, `parameters`, `idempotency_key`, `reservation_id`, details. | Submit an edit; supported modes depend on the selected model. May spend credits. |
| `media_status` | Supply `request_id` or alias `generation_id`; optional details. | Read existing job status and output URL; detailed response adds model/kind metadata. |

Example read-only quote arguments:

```json
{
  "sku": "media.image.generate",
  "units": 1,
  "model": "MODEL_FROM_CATALOG",
  "metadata": {"aspect_ratio":"4:5"},
  "include_details": true
}
```

Replace uppercase placeholders with discovered values. The base unified media
schema does **not** advertise `max_credits` or `quote_id` as generation arguments.
Do not invent those fields or treat a quote as an enforced cap. If you need an
explicit capped confirmation, use the direct endpoint's
`preview_generation` → `confirm_generation` flow, or a deployed batch contract
that enforces `max_credits`.

After an authorized submission, poll `media_status` with the returned ID.
Detailed mode may expose billing metadata; it must not expose bearer tokens.
Idempotency is scoped by the service: preserve the original key and inputs.
Direct `generate` on the other endpoint has different retry behavior.

### Batch media generation — Wave 4 extension

`media_batch_generate` is an **opt-in integration-stage tool**. Its module does
not by itself register the tool or implement the backing service. Confirm its
presence and working backend before relying on it. An offline preview is not a
submitted batch and reserves no credits.

| Field | Contract |
| --- | --- |
| `batch_id` | Required, 1–128 characters; starts alphanumeric and otherwise uses letters, digits, `.`, `_`, or `-`. Reuse only for retries of the same pack. |
| `prompt` | Required nonblank string, at most 32,000 characters; shared by all items. |
| `model` | Required nonblank model identifier, at most 256 characters. |
| `kind` | `image` (default) or `video`. Audio is not supported by this batch schema. |
| `aspect_ratios` | One to four unique values from `1:1`, `4:5`, `16:9`, `9:16`; defaults to all four in that order. |
| `max_credits` | Optional nonnegative integer hard cap, enforced before reservation by the backend. |
| `include_details` | Default false; adds the fingerprint, child request details, and reservation ID. |

```json
{
  "batch_id": "product-pack-001",
  "prompt": "A ceramic mug on a plain studio background",
  "model": "MODEL_FROM_CATALOG",
  "kind": "image",
  "aspect_ratios": ["1:1","4:5","16:9","9:16"],
  "max_credits": 100,
  "include_details": true
}
```

The cap above is illustrative, not a price quote. The backend must quote and
reserve the entire pack before admitting any child job. **Atomic means
all-or-none admission**, not rollback of completed provider renders. Each
zero-based item has the stable key `batch_id:item:index`. Preserve array order,
model, prompt, and cap on retries; a changed fingerprint under the same batch ID
must be refused.

The result contains `batch_id`, `status`, `item_count`, `reservation`, and
`items`. Reservation fields distinguish upfront admission, estimated credits,
reserved credits, and `reserved`/`settled`/`released` status. Each admitted item
has a generation ID, status, and optional output URL. Retain those IDs to inspect
individual jobs. Successful admission does not imply every render completed.
An unsupported backend fails closed instead of falling back to partially paid
single-item submissions.

### Credit receipts — Wave 4 extension

`credits_receipt` is also opt-in and requires a complete, authorized backend
ledger. It summarizes actual recorded credits, not estimated provider dollars.

| Field | Contract |
| --- | --- |
| `session_id` | Optional nonblank ID, at most 256 characters. At least one of session or run is required. |
| `run_id` | Optional nonblank ID, at most 256 characters. When both IDs are given, their scopes intersect. |
| `capabilities` | One to four unique values: `llm-gateway`, `unified-mcp`, `evolve-si`, `discover-si`; defaults to all four. |
| `format` | `json` (default) or `csv`. |
| `include_details` | Default false; include individual ledger rows when true. |

```json
{
  "run_id": "RUN_ID_FROM_SERVICE",
  "capabilities": ["evolve-si","unified-mcp"],
  "format": "json",
  "include_details": true
}
```

The response includes `status`, scope IDs, `format`, `summary`, and a
capability/model `breakdown`. Summaries include entry count, `credits_spent`,
`prompt_cache_savings_credits`, `credits_without_cache`, and `cached_input_tokens`.
Details add `entries`; CSV mode adds escaped CSV text. Unknown savings or cached
token counts remain null, including aggregates that cannot be established from
their rows. An unavailable ledger returns offline/unknown information; it is not
evidence of zero spend. Partial ledger pages must not be presented as complete
receipts. Reservations and settled spend are different quantities.

## Super Intelligence tools

These unified tools are on **app.omnisi.ai/mcp**:

| Tool | Inputs | Result and behavior |
| --- | --- | --- |
| `si_decision_ask` | `title`, `question`, `kind` = `approval`/`choice`/`question`, options, recommendation, answerers, unknowns, idempotency key, details; forwards to the decision handler. | Creates a structured human question. Delivery is not approval. Inspect `decision_ask` for required forwarded fields. |
| `si_discover` | `action` = `launch` (default) or `status`; launch uses `objective`, `pack_ids`, optional `lenses`, `constraints`; status needs `run_id`; details optional. | Launches or reads a discovery run. Launch may consume credits; status recovers an existing run. |
| `si_evolve` | `action` = `start` (default), `status`, or `promote`; `execution_tier` = `hosted_pro` or `hosted_super_intelligence` (default); optional `target` (default `prompt`), `spec`, `generations` (1–8, default 3), `candidates_per_generation` (1–8, default 4), details; status requires `run_id`; promote requires `run_id` and `candidate_id`. | Start/read a hosted optimization or request promotion. Inspect durable evidence and gate results before adopting a winner. |

The inspected `si_decision_ask` wrapper advertises an array for `answerers`, while
the underlying `decision_ask` contract uses an object such as
`{"people":["PERSON_ID"]}` and also requires `why`. Use the direct
`decision_ask` schema until the wrapper and handler are aligned; do not guess a
payload around incompatible schemas.

The inspected base `si_evolve` handler includes in-memory sample completion
records. Those are not proof of a real ensemble or promotion. Use an integrated
hosted deployment with durable run, evaluation, spend, and promotion records.
The [Evolve guide](HOSTED-EVOLVE-SUPER-INTELLIGENCE.md) describes tier differences,
knockouts, Bradley–Terry/Elo leaderboards, and the JEV promotion gate.

Discover's lower-level tools, when its service is enabled:

| Tool | Inputs | Result |
| --- | --- | --- |
| `discover_launch` | `objective`, `pack_ids`; optional `lenses` with `id`, `label`, `question`, and `constraints`. | Run ID for multi-lens discovery over supplied evidence packs. |
| `discover_status` | `run_id`. | Current progress, findings, and completion state. |
| `discover_act` | `run_id`, `target_id`, `choice` (`start`, `dig_deeper`, `not_now`); action-specific `destination`, `decision_id`, `session_id`, `kind`, `contract`. | Apply an authorized follow-up to a finding; consult the schema and decision state first. |

There is no generic advertised MCP tool named `llm`, `image`, `video`, or `audio`.
Use `media_generate`/`generate` with the discovered modality/model. HTTP inference
at the gateway is separate from this MCP catalog.

## OmniSI collaboration catalog

The following tables cover the remaining inspected tool families, including
conditionally registered features. Inputs list principal identifiers and key
fields; `tools/list` supplies complete nested schemas and deployment-specific
limits. Never infer authority from a tool name or fabricate the human answer.

### Identity, decisions, and blind studies

| Tool | Inputs | Purpose/effects |
| --- | --- | --- |
| `whoami` | None. | Read verified person and organization identity. |
| `subscription_get` | None. | Read plan/seat status and account billing links. |
| `decision_ask` | Required `kind`, `title`, `question`, `why`, `unknowns`; optional options, recommendation, answerers, backup, action, page, due date, details, visibility, idempotency key, evidence links, fields. | Ask a person. Approval/choice requires a recommendation; use exact resolvable answerers. |
| `decision_get` | `decision_id`, optional `wait_seconds`. | Read/wait for a decision; may advance delivery state. |
| `decisions_list` | Optional `view`: `asked_by_me` or `waiting_on_me`. | List the caller's decision views. |
| `decision_ack` | `decision_id`. | Acknowledge delivery; does not execute the approved action. |
| `decision_report` | `decision_id`, `grant_id`, `action_digest`, `outcome`, `evidence`; optional `evidence_url`. | Report the exact authorized action's done/failed/cancelled result. |
| `decision_cancel` | `decision_id`, `reason`. | Cancel an eligible decision. |
| `decision_close` | `decision_id`, `expected_revision`, `conclusion`, `render_fingerprint`. | Close the reviewed revision under the caller's authority. |
| `decision_answer` | `decision_id`, `expected_revision`, `answer`. | Submit only an answer the authenticated caller is authorized to give; not a way for an assistant to invent approval. |
| `study_create` | `title`, `graders`, `items`; optional fields from schema. | Create a blind study with sealed source labels; does not authorize action. |
| `study_get` | `study_id`. | Read shuffled items or revealed results. |
| `studies_list` | None. | Read the team's study list with blind redaction. |
| `study_submit` | `study_id`, `render_fingerprint`, `answers`. | Record the signed-in grader's complete answer set. |
| `study_close` | `study_id`, `conclusion`, `render_fingerprint`. | Close and reveal study results as the authorized asker. |

### Pages and files

| Tool | Inputs | Purpose/effects |
| --- | --- | --- |
| `page_publish` | `title`; optional template, format, body, visibility, reviewers, files, idempotency key, ask. | Publish a page; visibility can make content public. |
| `page_update` | `slug`, `expected_revision`, `body`; optional title, visibility, reviewers, files. | Create an updated revision with conflict protection. |
| `page_get` | `slug`, optional `revision`. | Read a page. |
| `page_list` | Optional `limit`, `cursor`, `filter`. | List accessible pages. |
| `page_delete` | `slug`. | Delete a page under caller permissions. |
| `page_upload_file` | `slug`, `path`, `base64`, `expected_revision`; optional content type. | Upload/replace a small file, up to 4 MiB, in a new revision. |
| `page_request_upload` | `slug`, `path`, `size`, `sha256`, `expected_revision`; optional content type. | Reserve an upload and obtain a single-use streaming URL. |
| `page_resume_upload` | `slug`, `upload_id`. | Recover the next upload URL/offset. |
| `page_finalize_upload` | `slug`, `upload_id`. | Verify and finalize the reserved upload. |
| `page_list_files` | `slug`, optional `revision`. | List files for a page revision. |
| `page_delete_file` | `slug`, `path`, `expected_revision`. | Remove a file in a new revision. |
| `page_send` | `slug`, `to`; optional note/revision. | Email a page; requires authorization to contact recipients. |
| `page_comment` | `slug`, `body`; optional revision/parent ID. | Add a comment. |
| `page_comments` | `slug`, optional `since`. | Read comments. |
| `site_update` | `home_slug`, `menu`. | Update the team's site configuration. |

### Sessions, relay, shared tools, and marketplace

| Tool | Inputs | Purpose/effects |
| --- | --- | --- |
| `session_register` | `handle`; optional session ID, provider, mode, branch, status, summary. | Register/update a session record. |
| `sessions_list` | Optional `status`. | Read active/busy/idle/stopped session records. |
| `session_steer` | `target`, `directive`; optional priority, context, bridge option. | Queue steering for a session; delivery is not completion. |
| `session_wait` | Optional `session_id`, `wait_seconds`. | Receive pending steering. |
| `session_ack` | `message_id`. | Acknowledge a directive after applying it. |
| `omnios_sync_push` | `kind`, `subject_id`, `title`; optional summary, payload, sync ID. | Optional compatibility bridge: submit a scoped update. |
| `omnios_updates_list` | Optional direction, kind, limit. | Read optional compatibility-bridge updates. |
| `relay_send` | `title`, `summary`, `target_client`; optional context, artifact refs, recipient, decision; newer schema also requires `idempotency_key`. | Send a cross-client handoff. Discover dispatch approval requires provenance verification. |
| `relay_inbox` | Optional target client, status, recipient, limit; cursor support varies by schema. | Read available handoffs. |
| `relay_complete` | `relay_id` (or advertised alias `id`); optional status, resolution note, result payload. | Mark a handoff claimed/completed/cancelled. |
| `relay_verify` | `relay_id`. | Where advertised, verify dispatch provenance against the ledger. |
| `tools_list` | None. | Read your connections and actively shared tools. |
| `tools_call` | `provider`, `owner`, `operation`, `arguments`; optional `decision_id`. | Invoke an authorized shared tool; writes may require its owner's decision. |
| `marketplace_search` | Optional query, kind, category, subcategory. | Find Blueprints and OmniApps. |
| `blueprint_get` | `id`. | Read a blueprint and its interview/setup guidance. |
| `omniapp_get` | `id`. | Read an app kit and requirements; entitlement may limit access. |
| `marketplace_install_record` | `kind`, `item_id`; optional install ID, expected version, plan page, status, evidence. | Record setup progress; does not perform installation. |
| `blueprint_interview_save` | `blueprint_slug`; optional `answers`, `completed_steps`, `required_steps`, `status` (`in_progress`, `ready`, `launched`). | Save answers and completed setup steps. |
| `omniapp_preflight_check` | `app_slug`; optional `required_connections`, `active_connections`. | Check required connections before setup. |

## Direct OmniRogue catalog

The tools below are on **api.omnirogue.com/mcp**. Names and arguments are not
interchangeable with unified adapters. Feature-dependent tools appear only when
enabled. Use each returned `inputSchema` for nested model-specific inputs.

### Account, models, generation, and uploads

| Tool | Inputs | Result/effects |
| --- | --- | --- |
| `get_profile` | None. | Stable identity of the connected account. |
| `get_credits` | None. | Balance and applicable billing/included-benefit information. |
| `list_models` | Optional `category`, `query`. | Public model slugs, categories, and base catalog prices. |
| `get_model` | `model`. | Model input schema and usage notes; provider options may be narrower than API bounds. |
| `browse_models` | Category and optional prompt/model/settings from schema. | Model picker with available image/video options. |
| `quote_generation` | `model`, optional prompt and supported media settings. | Exact charge and billing source for those settings; no generation. Optional feature. |
| `preview_generation` | Model/category and supported settings from schema. | Expiring quote, balance, inclusion status, and spending cap; no generation. |
| `confirm_generation` | `quote_id`; optional `confirmed` as advertised. | Start the user-confirmed quote; repeat the same quote ID to recover its job. |
| `generate` | `model`; `prompt` unless an image input is supplied; optional image/video references, duration, resolution, quality, aspect ratio, audio switch, webhook, end-user ID, and enabled brand/cap fields. | Direct generation, including audio/music. Returns `id`, queued status, model, charged/remaining credits. Repeating can spend again. |
| `get_generation` | `id`. | Read job status and result URL. |
| `get_media_generation` | `id`. | Read media job with app-friendly results. Poll at least five seconds apart. |
| `wait_for_generation` | `id`; optional `timeout_seconds` 5–40. | Bounded wait; still-processing is a valid result, not cancellation. |
| `list_generations` | Optional category, limit (default 50, max 100), offset. | Saved history; some legacy row IDs are not pollable—use their result URL. |
| `upload_reference` | File input from the advertised schema. | Store a user-selected PNG/JPEG/WebP image, up to 10 MB/40 megapixels. No generation spend. |
| `upload_source_video` | File input from the advertised schema. | Store a user-selected MP4/MOV/WebM source, 4–30 seconds and up to 200 MB, for supported video editing. |

For images/video, prefer this sequence:

```text
list_models → get_model → preview_generation
→ show settings and price to the user → confirm_generation
→ get_media_generation → inspect/download the returned output
```

Preview quotes currently expire after ten minutes. A `notice`/`not_started`
response means generation did not start; present its reason. Direct generation
states include `queued`, `processing`, `completed`, `failed`, and `canceled`.
Inspect errors, refunds, and billing records rather than assuming a failed
request was free. Where `max_credits` is supported, use the returned quote's cap;
do not confuse a credit cap with a provider-currency spending cap.

For audio/music, discover a supported model with `list_models`, inspect
`get_model`, quote it where available, and call `generate` only within the user's
approved scope. Audio field names and duration bounds depend on the model.
There is no universal audio payload inferred from an image model's schema.

### Video workflows, Voice Studio, and creative skills

| Tool | Inputs | Result/effects |
| --- | --- | --- |
| `list_video_workflows` | None. | Supported workflow names, schemas, availability, and billing limits. |
| `start_video_workflow` | Discovered workflow input, account-scoped `idempotency_key`, supported cap. | Durable video job with child renders; preserve key on retries. |
| `get_video_job` | `id`. | Read/reconcile job outputs and recorded debits/refunds; does not submit new renders. |
| `list_video_jobs` | Optional limit (default 50, max 100), offset. | Recover job history and outputs. |
| `list_voices` | None. | Available/cloned voices, delivery presets, and syntax examples. |
| `detect_video_characters` | `video_url` or `generation_id`; optional thumbnail URL. | Detect video characters for voice assignment. |
| `analyze_video_voices` | `video_url` or `generation_id`; optional thumbnail URL. | Analyze existing speakers/voices. |
| `start_voice_studio_job` | `kind` = `change_voice` or `add_voice`; video URL or generation ID; operation-specific prompt, voice, assignments, script, dialogue lines, or audio URL. | Submit a paid voice job; supports advertised lip-sync, background preservation, and delivery settings. |
| `get_voice_studio_job` | Job `id`. | Read Voice Studio progress and output. |
| `list_voice_studio_jobs` | Optional `source_ref`. | List Voice Studio jobs. |
| `wait_for_voice_studio_job` | `id`, optional timeout 5–40 seconds. | Bounded wait for the original job. |
| `list_skills` | Optional category (`voice`, `video`, `mirage`, `influencer`, `workflow`), query. | Read creative playbooks; no generation spend. |
| `get_skill` | `skill` slug. | Read full instructions, parameters, and example calls. |
| `apply_skill` | `skill`, `goal`; optional media references, character, camera, voice parameters. | Compile a prompt and tool-call plan; does not execute its paid steps. |

Only use voices and reference media the user has the right to use. A successful
upload or generated plan does not itself authorize voice cloning, publishing,
or sending content to an external provider.

### Brand campaigns and preset editing

| Tool | Inputs | Result/effects |
| --- | --- | --- |
| `list_brand_dna` | None. | Read available brands, versions, and associated asset IDs. |
| `start_image_campaign` | `brand_dna_id`, `request`. | Plan a campaign board; image rendering waits for card confirmation. |
| `get_image_campaign` | `campaign_id`. | Read plan, pending card, credits, and outputs. |
| `confirm_image_campaign` | `campaign_id`, `proposal_id`, `max_credits`. | Generate the specific card the user approved. |
| `review_image_campaign` | `campaign_id`. | Check outputs against the brief; corrections create another card requiring confirmation. |
| `list_saber_presets` | None. | Read available editing presets and recreation support. |
| `get_saber_preset` | `preset_id`; optional `duration` = `preset` or `short`. | Read slots, constraints, and live quote. |
| `start_saber_recreate` | Preset, media-slot map, duration, text/color fields as advertised, `idempotency_key`, required cap; music requires its consent field. | Recreate an enabled preset using supplied media. Preserve original identity on retry. |
| `get_saber_run` | Run `id`. | Read shot/composition progress, quote, actual credits, and final video. |

### Human work and opted-in computer controls

| Tool | Inputs | Result/effects |
| --- | --- | --- |
| `work_send` | `requestId`, `recipientEmail`, `title`, `note`; optional action, 2–6 options, recommended option ID. | Send work to an exact verified recipient; reuse request ID on retry. |
| `work_get` | `tenantId`, `taskId`. | Read work and its current version. |
| `work_wait` | `tenantId`, `taskId`, `sinceVersion`; optional timeout. | Wait for human progress/answer. No tool here can invent or complete the human decision. |
| `list_session_computers` | None. | Discover opted-in computer process identities. |
| `list_shared_sessions` | None. | Where enabled, discover exact owner-granted sessions. |
| `list_sessions` | `computerId`, `requestId`. | Queue a session inventory request for one computer. |
| `read_session` | Those IDs plus `sessionId`; optional `after`, supported grant ID. | Queue a bounded status/history read. |
| `start_session` | Computer/request IDs, `roomId`, `text`; optional `targetBotId`. | Start a task with saved models and existing approval controls. |
| `steer_session` | Computer/request IDs, `sessionId`, `text`; optional grant ID. | Queue steering at a supported boundary. |
| `cancel_session` | Computer/request IDs, `sessionId`; optional grant ID. | Request cancellation; confirm final runtime state. |
| `resume_session` | Computer/request IDs, `sessionId`, `text`; optional `targetBotId`. | Start a new supported text continuation in the same room. |
| `get_session_command` | `commandId`. | Read the original command receipt and actual computer response. |

Use the exact discovered computer identity. A queued/delivered command is not
completed execution, and an offline computer cannot be replaced by a similarly
named host. A session grant covers its specific run and permitted operations;
team membership does not imply access.

## Version and integration notes

- This reference intentionally distinguishes all inspected tool families from
  the subset enabled on a particular account. Retrieve the complete live schemas
  with `tools/list`; optional tools may be absent.
- `credits_receipt` and `media_batch_generate` require registration and backend
  integration beyond their Wave 4 definitions. No direct OmniRogue MCP batch
  alias was present in the inspected catalog. A REST batch service does not
  automatically create an MCP tool.
- Relay schemas differ between service implementations. Inspect the schema for
  required idempotency fields and pagination rather than mixing versions.
- The base `si_evolve` sample handler and the `si_decision_ask` answerer mismatch
  described above are integration limitations, not guarantees of live behavior.
- The OSS sanitizer script was absent from the documentation worktree during
  preparation. Its required command could not pass. Release integration must
  supply and run the actual sanitizer; this document does not define or replace
  its forbidden-token policy.

Public entry points are [OmniSI](https://app.omnisi.ai),
[OmniRogue](https://omnirogue.com), and the
[OmniConsole repository](https://github.com/omnirogue/omniconsole).
For contribution and verification expectations, see
[CONTRIBUTING.md](../../.github/CONTRIBUTING.md).
