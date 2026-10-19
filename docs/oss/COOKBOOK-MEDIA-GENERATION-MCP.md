# Media generation MCP cookbook

This cookbook shows how to generate, edit, batch, voice, and track media through
the **unified OmniSI MCP** at `https://app.omnisi.ai/mcp`. It covers five tools:

- `media_generate`: submit one image, video, or audio job.
- `media_edit`: edit existing media, for example inpainting part of an image.
- `media_batch_generate`: render one prompt in up to four aspect ratios. The
  whole pack is admitted or refused together, under a hard credit cap.
- `media_voice_tts`: text-to-speech, if your deployment advertises it.
- `media_status`: read a job's status and output.

It describes the contracts in this source snapshot, reviewed on **2026-10-16**.
For your connection, the deployed server's `tools/list` response and returned
schemas are authoritative. Model availability, prices, feature flags, and account
permissions vary. This document quotes no prices.

New to OmniRogue? Start with the [connector guide](OMNIROGUE-CONNECTOR-GUIDE.md).
For every tool on both MCP endpoints, see the
[unified MCP reference](UNIFIED-MCP-REFERENCE.md).

## Contents

- [The five tools at a glance](#the-five-tools-at-a-glance)
- [How the pieces fit](#how-the-pieces-fit)
- [Before you start](#before-you-start)
- [Discover the live schemas](#discover-the-live-schemas)
- [Tool contracts](#tool-contracts)
- [Spend and safety rules](#spend-and-safety-rules)
- [Recipes](#recipes)
- [Choosing the right tool](#choosing-the-right-tool)
- [Troubleshooting](#troubleshooting)
- [Source anchors](#source-anchors)

## The five tools at a glance

| Tool | Status in this snapshot | Spend | Enforced credit cap | Safe retry |
| --- | --- | --- | --- | --- |
| `media_generate` | Base unified tool | May spend credits | None. Quote first. | Same `idempotency_key` and identical inputs |
| `media_edit` | Base unified tool | May spend credits | None. Quote first. | Same `idempotency_key` and identical inputs |
| `media_batch_generate` | Opt-in Wave 4 integration-stage tool. Present only when it is registered **and** backed by a working service. | Reserves the whole pack before any job starts | `max_credits` | Same `batch_id` and identical inputs |
| `media_voice_tts` | **Not in the inspected catalog.** This snapshot contains no definition or schema for it. | Treat as spending | Unknown. Read its schema. | Unknown. Read its schema. |
| `media_status` | Base unified tool | None. It reads an existing job. | Not applicable | Repeat freely |

**Call a tool only after `tools/list` or `tools_search` shows it on your
connection.** Optional tools can be absent even when the rest of the catalog
loads.

## How the pieces fit

```text
tools_search ─► credits_balance ─► credits_quote ─► the person approves
                                                          │
          media_generate · media_edit · media_voice_tts ◄─┤
          media_batch_generate (with max_credits)       ◄─┘
                                │
                     media_status (poll) ─► download the output
```

Three facts shape every recipe:

1. **Submitting is not finishing.** The submit tools return a request ID and a
   status. They do not wait for the output. You read the result with
   `media_status`.
2. **A quote is an estimate, not a cap.** `credits_quote` returns `quote_id`,
   `estimated_credits`, and `max_credits`. The base unified media schemas accept
   neither `quote_id` nor `max_credits`, so nothing ties the job to that quote.
   For an enforced cap, use `media_batch_generate` with `max_credits`. For a single
   job, use the direct endpoint's `preview_generation` → `confirm_generation`
   flow.
3. **Retries need the original identity.** Keep the request ID, idempotency key,
   or batch ID. With it, a timeout is recoverable. Without it, a retry can pay
   twice.

### Two endpoints

OmniConsole provisions both endpoints for agent launches when your OmniRogue
account is connected. The server names below are the ones OmniConsole writes into
agent MCP configurations.

| Server name | URL | Label in OmniConsole | Use it for |
| --- | --- | --- | --- |
| `omnisi` | `https://app.omnisi.ai/mcp` | OmniRogue & OmniSI Unified MCP | The five tools in this cookbook, plus `tools_search`, `credits_balance`, and `credits_quote` |
| `omnirogue` | `https://api.omnirogue.com/mcp` | OmniRogue Creative & Credits MCP | Model catalog (`list_models`, `get_model`), capped `preview_generation`/`confirm_generation`, direct `generate`, uploads, Voice Studio |

Tool names and arguments are **not interchangeable** between the endpoints. Don't
send unified arguments to direct `generate`. Don't assume one endpoint can read a
request ID issued by the other. The two are also separate protected resources:
authorization on one does not prove authorization on the other.

## Before you start

### In OmniConsole

1. **Connect your OmniRogue account.** See the
   [connector guide](OMNIROGUE-CONNECTOR-GUIDE.md).
2. **Launch the agent after linking.** When it launches a pane with a connected
   account, OmniConsole adds the unified MCP entries to the agent's MCP
   configuration. It also sets `OMNISI_MCP_URL`, `OMNIROGUE_MCP_URL`, and
   `OMNIROGUE_UNIFIED_MCP=1` in the agent's environment. A pane launched before
   you linked does not have them, so relaunch it.
3. **Authorize on first use.** The provisioned entries carry only OmniConsole's
   session attribution headers, `X-Omni-Ledger-Session` and
   `X-Omni-Ledger-Attempt`, and no credentials. Complete the endpoint's sign-in
   when your CLI asks for it, using the account you linked. In Claude Code,
   `/mcp` shows each server's connection and sign-in state.
4. **Find the tools.** In Claude Code, tools from the `omnisi` server appear as
   `mcp__omnisi__media_generate`, `mcp__omnisi__media_status`, and so on. Other
   CLIs use their own prefixes. [Recipe 1](#recipe-1-preflight-the-media-tools)
   lists them.
5. **Run diagnostics.** In Settings, the OmniRogue diagnostics card has a
   **Unified MCP** stage. It initializes both endpoints and pages through
   `tools/list`. See [Troubleshooting](#troubleshooting) for a known
   naming mismatch in this stage.

This snapshot also contains a Quick Generate dialog component: quote, credit
check, one ratio or a four-ratio pack, then the saved paths inserted into the
terminal. **It is not mounted in the app in this snapshot.** Use the MCP flow in
this cookbook instead.

### In another MCP client

Add the URL as a Streamable HTTP server, then complete the server's authorization
challenge. For example, in Claude Code:

```sh
claude mcp add --transport http omnisi https://app.omnisi.ai/mcp
```

Keep credentials in the client's secure configuration. Never put tokens in URL
query strings, source files, prompts, or screenshots.

## Discover the live schemas

Ask `tools_search` for the `media` namespace with full schemas:

```json
{"namespace":"media","limit":100,"include_details":true}
```

As a raw JSON-RPC request (your MCP client normally builds this):

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "tools_search",
    "arguments": {"namespace": "media", "limit": 100, "include_details": true}
  }
}
```

For each of the five tools, record:

- whether it is listed;
- its `inputSchema`: required fields, enums, defaults, and whether extra
  properties are rejected (most of these schemas reject them);
- its `outputSchema`, if present;
- annotations such as `readOnlyHint` and `idempotentHint`;
- the description, which may name the SKU to quote and the model families it
  accepts.

`include_details` changes how much the response tells you. It does not change
permissions or spend. **A detailed `media_generate` call still generates.** A
limited `tools_search` is not a complete inventory. For that, page through
`tools/list` with `nextCursor`.

**Model identifiers.** Take `model` values from a catalog your deployment
documents: the tool's description, an enum in its schema, or the direct
endpoint's `list_models` (optional `category`, `query`) and `get_model` (`model`).
`get_model` returns the model's input schema and usage notes. These tell you which
aspect ratios, durations, edit modes, and `parameters` it accepts. If a unified
tool rejects a model identifier, read the schema again rather than guessing
variants.

## Tool contracts

Fields not marked as required are optional. Conditional requirements still
apply.

### `media_generate`

| Field | Required | Contract |
| --- | --- | --- |
| `prompt` | Yes | What to produce. |
| `kind` | No | `image` (default), `video`, or `audio`. |
| `media_type` | No | Alias for `kind`. Pick one name and use it consistently. |
| `model` | No | A model identifier from discovery. This snapshot does not document what happens when it is omitted, so pass it whenever output or cost matters. |
| `aspect_ratio` | No | A ratio the model supports, for example `1:1`, `4:5`, `16:9`, or `9:16`. |
| `duration_seconds` | No | For video and audio. Bounds depend on the model. |
| `parameters` | No | An object of model-specific settings, taken from the model's schema. |
| `idempotency_key` | No | Your key for this logical request. **Set it on every call** and reuse it, with identical inputs, only when retrying that same request. |
| `reservation_id` | No | A credit reservation the service issued to you. This snapshot does not document how to obtain one for a single job. Omit it unless your deployment's schema explains it. |
| `include_details` | No | Default `false`. Adds metadata, not permissions. |

**Result:** a request ID and a status. Save the ID before you do anything else.

**Not accepted:** `max_credits` and `quote_id`. Adding them is an extra property,
which most of these schemas reject. It would not enforce a cap anyway.

```json
{
  "prompt": "A matte-black ceramic mug on pale linen, soft window light, product photo",
  "kind": "image",
  "model": "MODEL_FROM_CATALOG",
  "aspect_ratio": "4:5",
  "idempotency_key": "mug-hero-20261016-01",
  "include_details": true
}
```

Replace uppercase placeholders with discovered values throughout this cookbook.

### `media_edit`

| Field | Required | Contract |
| --- | --- | --- |
| `image_url` | Yes | The source media. Use an output URL returned by `media_status`, or another HTTPS URL that the service can fetch and that you have the rights to use. |
| `prompt` | Yes | The change to make. |
| `edit_mode` | No | Default `inpaint`. Other modes depend on the selected model; take them from its schema. |
| `kind` | No | `image` (default) or `video`. |
| `mask_url` | No | A mask for region edits. The format (which pixels are editable, required dimensions) is model-specific. |
| `model`, `parameters`, `idempotency_key`, `reservation_id`, `include_details` | No | Same meaning as for `media_generate`. |

**Result:** a request ID and a status, like `media_generate`. Each edit is a
separate paid submission with its own request ID.

The source field is named `image_url` for both kinds. For `kind: "video"`, confirm
in the model's schema which source media it accepts before you spend.

The unified schema takes a URL, not file bytes. The direct endpoint has
`upload_reference` (PNG, JPEG, or WebP; up to 10 MB and 40 megapixels) and
`upload_source_video` (MP4, MOV, or WebM; 4–30 seconds; up to 200 MB) for its own
workflows. This snapshot does not document passing their results to `media_edit`.

### `media_status`

| Field | Required | Contract |
| --- | --- | --- |
| `request_id` | One of the two | The ID returned by a submit call. |
| `generation_id` | One of the two | Alias for `request_id`. Batch items report generation IDs. |
| `include_details` | No | Adds model and kind metadata, and may add billing metadata. It must not expose bearer tokens; report it if it does. |

**Result:** the job's status and, when available, its output URL. It is
read-only, so you can call it as often as your rate limit allows. It is also
how you recover from a timeout.

**Status values.** This snapshot does not enumerate the unified status values.
The direct endpoint uses `queued`, `processing`, `completed`, `failed`, and
`canceled`. Treat any value that is not clearly a finished success or a finished
failure as still running.

**Polling.** Start at 5 seconds and back off toward 30–60 seconds for video.
Honor any 429 backoff. The direct endpoint asks for at least five seconds between
`get_media_generation` polls; use the same floor here.

### `media_batch_generate`

| Field | Required | Contract |
| --- | --- | --- |
| `batch_id` | Yes | 1–128 characters. Starts with a letter or digit, then letters, digits, `.`, `_`, or `-`. Reuse it only to retry the same pack. |
| `prompt` | Yes | Non-blank, at most 32,000 characters. Shared by every item. |
| `model` | Yes | Non-blank model identifier, at most 256 characters. |
| `kind` | No | `image` (default) or `video`. **Audio is not supported.** |
| `aspect_ratios` | No | One to four unique values from `1:1`, `4:5`, `16:9`, `9:16`. Defaults to all four in that order. |
| `max_credits` | No | Non-negative integer hard cap. The backend enforces it before reserving anything. |
| `include_details` | No | Default `false`. Adds the fingerprint, child request details, and reservation ID. |

**How admission works:**

- The backend quotes and reserves the **entire** pack before admitting any child
  job. Admission is all-or-none. A pack that would exceed `max_credits` is
  refused before any credits are reserved.
- All-or-none applies to **admission only**. Renders that have already finished
  are not rolled back if a later item fails.
- Each zero-based item has the stable key `batch_id:item:index`.
- A fingerprint covers the prompt, model, cap, and array order. Reusing a
  `batch_id` with a changed fingerprint must be refused.
- If the backend does not support batches, the call fails closed. It does not
  fall back to separately paid single submissions.

**Result:** `batch_id`, `status`, `item_count`, `reservation`, and `items`.

- `reservation` distinguishes upfront admission, estimated credits, and reserved
  credits. Its status is `reserved`, `settled`, or `released`.
- Each admitted item has a generation ID, a status, and an optional output URL.

Successful admission does not mean every render completed. Poll each item.

### `media_voice_tts`

**No definition of `media_voice_tts` exists in any source inspected for this
snapshot.** That covers the unified catalog reference and the desktop source. Its
field names, voices, length limits, output format, and price unit are not
documented here. This cookbook does not invent them.

If your connection lists it:

1. Fetch its detailed schema:
   `{"query":"media_voice_tts","include_details":true}` on `tools_search`.
2. Read its required fields, enums (voices, formats), limits, annotations, and
   description.
3. Quote it with `credits_quote` if the description or schema names a SKU or
   operation. Don't guess a SKU.
4. Confirm that the person has the rights to the voice. Tool availability does
   not authorize cloning or imitating a real person's voice.
5. Submit with an idempotency key if the schema has one.
6. If it returns a request ID, read progress with `media_status`, unless the tool
   documents a different status path. If it returns the audio directly, save it
   immediately.

If it is not listed, use one of these routes:

| Need | Route |
| --- | --- |
| A narration or voiceover file | `media_generate` with `kind: "audio"` and an audio-capable model. Model-specific fields go in `parameters`. |
| Audio or music with a model's own fields | Direct `generate` on `api.omnirogue.com/mcp`, after `list_models` → `get_model`, and `quote_generation` where it is available. |
| Add or change a voice in an existing video | Direct Voice Studio: `list_voices` → `start_voice_studio_job` (`kind` = `add_voice` or `change_voice`) → `wait_for_voice_studio_job` or `get_voice_studio_job`. These jobs are paid. |

There is no universal audio payload. Don't infer audio fields from an image
model's schema.

## Spend and safety rules

- **Read before you write.** `tools_search`, `credits_balance`, `credits_quote`,
  and `media_status` are reads. `media_generate`, `media_edit`,
  `media_batch_generate`, and `media_voice_tts` can spend.
- **Get approval for the exact scope.** Before submitting, show the person the
  model, settings, item count, estimated credits, and spendable balance. Submit
  only what they approved. Annotations such as `readOnlyHint` describe intended
  behavior; they do not grant permission to spend.
- **Use an enforced cap where one exists.** Use `max_credits` on
  `media_batch_generate`, or the direct `preview_generation` →
  `confirm_generation` flow. Preview quotes expire after about ten minutes. A
  `notice` or `not_started` response means nothing started.
- **One idempotency key per logical request.** Never resubmit after a timeout
  with a new key. Reconcile first ([Recipe 8](#recipe-8-recover-after-a-timeout-or-crash)).
- **Check `isError`.** An HTTP 200 or a JSON-RPC result alone does not prove
  success.
- **A failed job is not necessarily free.** Inspect billing records. Where
  `credits_receipt` is listed, it summarizes recorded credits by `session_id` or
  `run_id`. An unavailable ledger is not evidence of zero spend.
- **Rights and consent.** Use only reference images, masks, voices, and likenesses
  the person may use. Generating an asset does not authorize publishing it or
  sending it to another provider.
- **Credentials.** Never paste tokens into prompts, arguments, file names, or
  issue reports. Output URLs may be signed; treat them as private.

## Recipes

### Recipe 1: Preflight the media tools

Confirm what your connection offers before planning paid work.

1. Call `tools_search` with
   `{"namespace":"media","limit":100,"include_details":true}`.
2. Call `credits_balance` with `{"include_details":true}`. The detailed response
   adds reservations and the linked identity. Plan against spendable credits,
   not the total.
3. Note which of the five tools are listed, and save their schemas.

Prompt for an agent in OmniConsole:

```text
Using the omnisi MCP server, call tools_search with
{"namespace":"media","limit":100,"include_details":true} and credits_balance
with {"include_details":true}. Report which of media_generate, media_edit,
media_batch_generate, media_voice_tts and media_status are listed, the required
fields of each, and my spendable balance. Do not call any tool that generates,
edits or spends.
```

### Recipe 2: One image, quoted and approved

1. **Quote** with `credits_quote`:

   ```json
   {
     "sku": "media.image.generate",
     "units": 1,
     "model": "MODEL_FROM_CATALOG",
     "metadata": {"aspect_ratio": "4:5"},
     "include_details": true
   }
   ```

   This snapshot documents only the `media.image.generate` SKU. For other kinds,
   take the SKU (or its alias `operation`) from the `credits_quote` schema or
   description.

2. **Show** the person the estimate, the model, the settings, and the spendable
   balance. Wait for a clear yes.
3. **Submit** `media_generate` with the arguments from
   [the `media_generate` contract](#media_generate) and a fresh `idempotency_key`.
4. **Save** the returned request ID next to the key and the arguments.
5. **Poll** `media_status` with `{"request_id":"REQUEST_ID"}` until it finishes.
6. **Download** the output URL promptly. This snapshot does not document how long
   output URLs remain valid. If a download fails, read `media_status` again
   rather than generating again.

### Recipe 3: A short vertical video

Video uses the same tool with `kind: "video"`. Take duration bounds and supported
ratios from `get_model`, and quote with the SKU the schema names.

```json
{
  "prompt": "Slow push-in on a ceramic mug as steam rises, morning light, shallow depth of field",
  "kind": "video",
  "model": "VIDEO_MODEL_FROM_CATALOG",
  "aspect_ratio": "9:16",
  "duration_seconds": 5,
  "parameters": {},
  "idempotency_key": "mug-reel-20261016-01"
}
```

Replace the empty `parameters` with the model's own settings, or drop the field.
Video takes longer than images: poll with backoff, and treat a long
`processing` state as normal, not as a failure.

### Recipe 4: Edit part of an image

Inpaint a region of the image from Recipe 2.

1. Get the source URL from `media_status` for the original request.
2. Prepare a mask in the format the model's schema describes, and host it at a
   URL the service can fetch.
3. Quote the edit, show it, and get approval.
4. Submit `media_edit`:

   ```json
   {
     "image_url": "OUTPUT_URL_FROM_MEDIA_STATUS",
     "prompt": "Replace the linen with a light oak tabletop; keep the mug unchanged",
     "edit_mode": "inpaint",
     "mask_url": "MASK_URL",
     "model": "EDIT_MODEL_FROM_CATALOG",
     "idempotency_key": "mug-hero-oak-20261016-01"
   }
   ```

5. Poll `media_status` with the new request ID.

Use a new idempotency key for each distinct edit. Reuse a key only to retry the
same edit.

### Recipe 5: A four-ratio pack under a hard cap

Render one prompt for feed, story, and landscape placements with one approval
and an enforced ceiling.

1. Confirm `media_batch_generate` is listed ([Recipe 1](#recipe-1-preflight-the-media-tools)).
2. Quote four units, show the estimate, and agree a cap with the person.
3. Submit:

   ```json
   {
     "batch_id": "mug-pack-20261016-001",
     "prompt": "A matte-black ceramic mug on pale linen, soft window light, product photo",
     "model": "MODEL_FROM_CATALOG",
     "kind": "image",
     "aspect_ratios": ["1:1", "4:5", "16:9", "9:16"],
     "max_credits": 100,
     "include_details": true
   }
   ```

   The cap here is illustrative, not a price.

4. Read the result. Check `status` and `item_count`. Check that
   `reservation.status` is `reserved` or `settled`, and compare the reserved
   credits with your cap.
5. Save every item's generation ID. Poll each with
   `{"generation_id":"GENERATION_ID"}` on `media_status`.
6. Match outputs to ratios by item index. Items keep the order of
   `aspect_ratios`, and each has the key `batch_id:item:index`.

**Retrying:** send the same `batch_id` with exactly the same prompt, model,
kind, ratio order, and cap. For a different pack, use a new `batch_id`. Every item
shares one prompt. If each ratio needs its own prompt, submit separate jobs
instead.

### Recipe 6: When batch generation is not listed

Don't let an agent silently replace one capped, all-or-none batch with several
uncapped jobs. Ask the person to choose:

| Option | Cap | All-or-none | Steps |
| --- | --- | --- | --- |
| Direct preview and confirm per ratio | Yes, per item | No | On `api.omnirogue.com/mcp`: `preview_generation` for each ratio → show all quotes → `confirm_generation` for each approved quote → `get_media_generation` |
| Separate `media_generate` calls | No | No | Quote every item → approve the total → one `media_generate` per ratio, each with its own idempotency key → `media_status` for each |

If some items fail in either option, the others may already have been charged.
Report each item's state rather than a single pass or fail.

### Recipe 7: Voiceover and narration

**Path A: `media_voice_tts` is listed.** Follow the six steps in
[its section](#media_voice_tts). Build the arguments from its schema only.

**Path B: unified audio.** Use `media_generate` with an audio-capable model:

```json
{
  "prompt": "Warm, unhurried narrator: \"Meet the mug that keeps coffee hot for six hours.\"",
  "kind": "audio",
  "model": "AUDIO_MODEL_FROM_CATALOG",
  "duration_seconds": 8,
  "idempotency_key": "mug-vo-20261016-01"
}
```

Some models read the prompt verbatim; others treat it as a description. Check the
model's notes in `get_model`. Voice selection, if the model supports it, goes in
`parameters` under the name its schema uses.

**Path C: direct audio.** Call `list_models` → `get_model` → `quote_generation`
(where available) → `generate`, then poll `get_media_generation` or
`wait_for_generation` (a bounded wait of 5–40 seconds). Repeating direct
`generate` can spend again, so keep the returned `id`.

To put a voice onto an existing video, use Voice Studio instead (see
[`media_voice_tts`](#media_voice_tts)).

### Recipe 8: Recover after a timeout or crash

A timeout means the outcome is unknown. It does not mean the request failed.

1. **Have a request or generation ID?** Call `media_status`. Do not resubmit.
2. **Have only the idempotency key?** Retry the same tool with the **same key and
   identical arguments**. Within the service's idempotency scope, this returns the
   original job instead of starting a new one.
3. **A batch?** Retry with the same `batch_id` and identical inputs, then poll
   each item's generation ID.
4. **A direct confirmed quote?** Repeat `confirm_generation` with the same
   `quote_id` to recover its job.
5. **Have neither an ID nor a key?** Stop. Check history, for example
   `list_generations` on the direct endpoint, and ask the person before
   submitting anything new.

Afterwards, compare what was charged with what was delivered. Where
`credits_receipt` is listed, read it for the session or run.

### Recipe 9: Hand the workflow to an agent

Paste this into an agent pane in OmniConsole, adjusting the brief:

```text
Goal: a 4:5 product image of a matte-black ceramic mug on pale linen.

Use the omnisi MCP server. Rules:
1. Discover first: tools_search {"namespace":"media","include_details":true}
   and credits_balance {"include_details":true}. Use only listed tools and
   build arguments from their schemas; no extra fields.
2. Pick a model from the catalog and quote with credits_quote. Show me the
   model, settings, estimate and spendable balance, then STOP and wait for my
   yes. Do not generate, edit or spend before that.
3. After my yes, submit exactly what I approved, with an idempotency_key you
   show me. Save the request ID.
4. Poll media_status, starting at 5 seconds with backoff. Report the final
   status and output URL.
5. On a timeout or unknown result, do not resubmit with a new key. Call
   media_status, or retry with the same key and identical arguments.
6. If a tool is missing or an argument is rejected, stop and tell me. Do not
   substitute another model or tool silently.
```

### Recipe 10: Poll and download from a script

This script only reads. It polls `media_status` for request IDs you already
have and downloads finished outputs. It never submits, edits, or retries a paid
call. It uses the official MCP Python SDK (`pip install mcp`).

```python
"""Poll media_status for saved request IDs and download finished outputs."""
import asyncio
import json
import os
import re
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = "https://app.omnisi.ai/mcp"
# Assumed names: confirm against media_status's outputSchema or a detailed
# response from your deployment, and edit these before relying on the script.
STATUS_FIELD, OUTPUT_FIELD = "status", "output_url"
DONE, FAILED = {"completed"}, {"failed", "canceled"}


async def poll(session, request_id, out_dir, max_wait=1800):
    delay, waited = 5, 0
    while waited < max_wait:
        result = await session.call_tool("media_status", {"request_id": request_id})
        if result.isError:
            raise RuntimeError(f"{request_id}: {result.content}")
        data = result.structuredContent or json.loads(result.content[0].text)
        status = data.get(STATUS_FIELD)
        if status in DONE and data.get(OUTPUT_FIELD):
            url = data[OUTPUT_FIELD]
            name = re.sub(r"[^A-Za-z0-9._-]", "_", request_id)
            target = out_dir / f"{name}{Path(urlparse(url).path).suffix}"
            urllib.request.urlretrieve(url, target)
            print(f"{request_id}: saved {target}")
            return
        if status in FAILED:
            print(f"{request_id}: {status}; check billing before resubmitting")
            return
        await asyncio.sleep(delay)
        waited += delay
        delay = min(delay * 2, 60)
    print(f"{request_id}: still {status}; poll again later, do not resubmit")


async def main(request_ids):
    # Load the credential your deployment's authorization flow issued from your
    # secret store into this variable. Never hard-code it.
    headers = {"Authorization": f"Bearer {os.environ['OMNISI_BEARER_TOKEN']}"}
    out_dir = Path("media-out")
    out_dir.mkdir(exist_ok=True)
    async with streamablehttp_client(URL, headers=headers) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            for request_id in request_ids:
                await poll(session, request_id, out_dir)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
```

Run it as `python poll_media.py REQUEST_ID [REQUEST_ID ...]`. `OMNISI_BEARER_TOKEN`
is a variable name you choose. This snapshot does not define how a script obtains
a credential; use your deployment's supported flow.

## Choosing the right tool

| You want | Use |
| --- | --- |
| One image, video, or audio asset | `media_generate` |
| The same prompt in two to four standard ratios, with one approval and a hard cap | `media_batch_generate` |
| A hard cap on a single job | Direct `preview_generation` → `confirm_generation` |
| A different prompt for each ratio | Separate `media_generate` calls (a batch shares one prompt) |
| To change part of an existing image | `media_edit` with `inpaint` and a mask |
| Speech from text | `media_voice_tts` if listed; otherwise `media_generate` with `kind: "audio"`, or direct `generate` |
| A voice added to or changed in an existing video | Direct Voice Studio |
| Progress, output, or recovery after a timeout | `media_status` |

## Troubleshooting

| Symptom | Likely cause and next step |
| --- | --- |
| A tool from this cookbook is not listed | It is optional, not enabled for the account, or on the other endpoint. Check `tools/list` on `app.omnisi.ai/mcp`. `media_batch_generate` needs registration and a working backend; `media_voice_tts` had no definition in this snapshot. |
| Diagnostics: `Missing tools: credits., media., si.` while `tools/list` shows `credits_balance`, `media_generate`, and similar | In this build, the Unified MCP stage looks for tool names that start with `credits.`, `media.`, and `si.`, plus `tools_search`. Underscore names such as `media_generate` don't match those prefixes. Trust `tools/list`, then call the tools directly. |
| The agent can't see the `omnisi` tools after you linked the account | The pane launched before linking. Relaunch it, then complete the server's sign-in (`/mcp` in Claude Code). |
| Invalid-argument error | An extra or misspelled field, or a value outside an enum. Common causes: `max_credits` or `quote_id` sent to `media_generate`; `kind: "audio"` sent to `media_batch_generate`; a ratio outside the batch set. Refresh the schema and resend. |
| 401 | Not authorized for this resource. OmniSI and OmniRogue authorize separately. Reauthorize the endpoint you are calling. |
| 403 | The account lacks permission for this tool or model. Check scopes and plan; don't retry unchanged. |
| 429 | Rate limited. Honor the backoff and slow your polling. |
| A submit call timed out | The outcome is unknown. Follow [Recipe 8](#recipe-8-recover-after-a-timeout-or-crash). Don't resubmit with a new key. |
| Batch refused for the same `batch_id` | The inputs changed, so the fingerprint differs. Resend the original inputs to recover it, or use a new `batch_id` for a new pack. |
| Batch refused before admission | The pack would exceed `max_credits`, or the backend doesn't support batches (it fails closed). Raise the cap with the person's approval, or use [Recipe 6](#recipe-6-when-batch-generation-is-not-listed). |
| Batch admitted, but some items failed | Admission is all-or-none; renders are not. Poll each item, then report each item's state and the reservation status. |
| A job stays in `processing` | Normal for video. Keep polling with backoff. Still processing is not a failure, and resubmitting can pay twice. |
| The output URL no longer downloads | Read `media_status` again for the current output. Don't regenerate. |
| The quote differs from the charge | Quotes from `credits_quote` are estimates. For an enforced ceiling, use a batch cap or direct preview and confirm. |

When you report a problem, include the app or client version, the endpoint, the
tool name, sanitized arguments, the request or batch ID, the idempotency key, the
error text, and a timestamp. Never include tokens or signed output URLs.

## Source anchors

These files describe this checkout, not a particular hosted deployment:

- Tool contracts, quoting, batch semantics, and the direct catalog:
  [`UNIFIED-MCP-REFERENCE.md`](UNIFIED-MCP-REFERENCE.md)
- MCP server names, URLs, and labels:
  [`omni-console-mcp-ledger-headers.ts`](../../src/shared/omni-console-mcp-ledger-headers.ts)
- Launch-time MCP provisioning and environment:
  [`apply-omnirogue-mcp-env.ts`](../../src/main/mcp/apply-omnirogue-mcp-env.ts)
- Session attribution headers:
  [`session-ledger-env.ts`](../../src/shared/session-ledger-env.ts)
- Diagnostics: [`omnirogue-doctor.ts`](../../src/main/omnirogue-account/omnirogue-doctor.ts)
- Quick Generate dialog, present but not mounted:
  [`omnirogue-media/`](../../src/renderer/src/components/omnirogue-media/)
- `media_voice_tts`: no definition found in this snapshot.

Related guides: [connector guide](OMNIROGUE-CONNECTOR-GUIDE.md),
[unified MCP reference](UNIFIED-MCP-REFERENCE.md),
[hosted Evolve guide](HOSTED-EVOLVE-SUPER-INTELLIGENCE.md),
[contributing](CONTRIBUTING.md).
