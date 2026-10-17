# Optional local Laya comparison

Laya observes successful Jev decisions through the existing structured-decision
service. Its result never changes a routine result, model choice, permission,
advertising action or completion receipt. Jev and all deterministic checks remain
authoritative. Installation is optional and disabled when `laya-shadow.json` is
absent. This is an experimental English checkpoint, not a calibrated confidence
gate or demonstrated production improvement.

## Pinned inputs

`config/laya/manifest.json` pins upstream source commit
`42626c348753fbb17572a813127df2278a1ec527` and the
`convaiinnovations/laya-typed-decisions` checkpoint at
`f9ab0b228f0fc0f14d873dbc99038f135c2da1b2`. Every source, configuration, tokenizer
and weight file is verified by SHA-256 before Python imports Laya. No remote model
code is enabled. Explicit provisioning downloads the snapshot; serving uses
offline Hugging Face/Transformers mode and requires a complete local encoder and
tokenizer. Additional files in the source/model directories are refused.

Dependencies are isolated from Electron and pinned in `config/laya/requirements.txt`.
Python 3.11 is required. The initial CPU runner is for a reproducible comparison;
it does not establish the performance of a warmed GPU or Apple Silicon worker.
Transitive Python dependencies remain subject to pip resolution. Treat the
environment as an experimental worker and retain its package inventory with an
evaluation. A production promotion should freeze the complete platform lock.

## Provisioning on the execution host

Run setup in a dedicated environment on the host that owns the structured
decision runtime. Use an absolute directory under the operator's project/output
root; `checkpoint.py download` requires a new directory and refuses overwrite.

For a Linux CPU-only host, install `torch==2.8.0` from
`https://download.pytorch.org/whl/cpu` in that venv before the requirements below,
using `pip install --no-cache-dir torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu`.
The manual GitHub pilot does this and verifies `2.8.0+cpu` without CUDA. The generic
Linux PyPI wheel otherwise downloads GPU libraries that exhaust the pilot runner's disk.

```sh
python3.11 -m venv /absolute/laya-worker-venv
/absolute/laya-worker-venv/bin/python -m pip install -r config/laya/requirements.txt
/absolute/laya-worker-venv/bin/python config/laya/checkpoint.py download /absolute/laya-checkpoint
```

Create `<userDataPath>/laya-shadow.json` with private file permissions. Generate
a fresh random 32-byte hexadecimal token, keep it only in that private file, and
use the same settings file for the worker. Never commit a real token. Example
shape (the placeholder deliberately fails validation):

```json
{
  "version": 1,
  "enabled": true,
  "capabilities": ["routine.structured", "orchestration.error_classification"],
  "token": "REPLACE_WITH_PRIVATE_RANDOM_64_HEX_TOKEN"
}
```

The baseline `structured-decisions.json` must also enable each selected
capability. Existing routine preferences, overrides, self-ownership checks and
the global kill switch apply to both providers. Removing the local file,
setting its `enabled` to false or using the existing structured-decision disable
RPC stops Laya admission and cancels pending app requests. An already executing
bounded inference can finish inside the worker after HTTP cancellation; its
result is discarded by the service. Stop the worker process to release memory.

```sh
/absolute/laya-worker-venv/bin/python -B config/laya/serve.py \
  --checkpoint /absolute/laya-checkpoint \
  --settings /absolute/profile/laya-shadow.json --device cpu
```

Use `--device mps` or `--device cuda` only on a host with that device. Fallback
to a different device causes refusal, including a fallback during inference.
The worker binds only `127.0.0.1:47831`, requires bearer authentication and refuses
browser-origin requests. It loads before reporting readiness. Run one worker
per host; it serves one inference at a time. The app bounds its shadow queue to
four waiting requests and one active request, with the existing maximum five
second deadline and no Laya retries. The app never spawns Python or fetches
weights automatically. Model lifecycle is managed separately from Electron.

Remote work stays on its owning runtime: no SSH/WSL request falls back to this
desktop worker. A paired runtime must be independently provisioned and configured.
Folder workspaces use the same host-level configuration; no git checkout is
required for evaluation. Old clients ignore the optional `layaShadow` status
field. There is no new RPC request, renderer setting or stream opcode.

## Input coverage and telemetry

Laya accepts at most eight questions, twenty choice options, and its pinned
1,024-token sequence with a 256-token instruction/option budget. Upstream also
limits each option to 48 tokens. The worker checks the actual tokenizer lengths
and refuses any input that upstream would shorten, including instructions,
options, state and literal mask tokens. It does not summarize or silently
truncate Jev evidence. Non-English performance has not been established for
this checkpoint.

`structuredDecision.status.layaShadow` reports configuration presence, runtime
counters and a bounded memory-only telemetry ring. `checkpointReadiness` stays
`unverified`: configuration presence is not a worker health probe. Successful
telemetry establishes an actual validated reply. No token, state, question text
or raw provider error is returned. Choice agreement is exact; numeric agreement
in ordinary telemetry is also exact and should not be interpreted as calibrated
semantic agreement. The manual evaluation uses the predeclared score tolerance.

Only successful Jev decisions are observed in the app, so this sample omits Jev
failures and is not an unbiased production-quality study. Laya errors and
unsupported inputs remain visible. Its probabilities/confidence are uncalibrated
for Omni; model agreement is not correctness. The worker adds compute and memory
cost even though it produces zero generated tokens.

## GitHub evaluation

The existing manual **Typesafe Evaluation** workflow accepts `comparator:
laya-local`. It provisions the pinned CPU checkpoint on the GitHub runner,
preloads the worker and compares it with fresh Jev calls on identical frozen
synthetic inputs. The Gemini default is unchanged. The existing exact `main-next`
SHA, environment, request/time/cost limits and output redaction still apply.
No local or fleet test suites are required or permitted by this workflow.

Select suite `core` and split `development`, `holdout` or `all`. The initial Laya
pilot rejects other suites before provisioning; advertising experiments retain
their existing Gemini comparator and numerical baselines. The original holdout has already been
inspected; reusing it is a regression comparison, not a fresh blinded study.
Unsupported/truncated inputs count in the assigned-case denominator. Report
coverage before comparing accuracy or matched latency. Laya hosting cost remains
unknown, not zero. All published cost estimates remain distinct from invoices.
The run never changes runtime configuration or promotes a provider.

Before a later promotion, obtain independent labels from an authorized real
workload, measure errors and abstentions, fit calibration on separate data, and
compare whole-workflow quality, latency, memory and cost. Proposed study targets
remain quality within two percentage points of baseline, at least 20% lower total
cost and at most 5% p95 latency regression; they are not established results.
