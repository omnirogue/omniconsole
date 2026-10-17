# Choosing workflow models: tiers, combos, OpenRouter prices and Ollama (2026-10-04)

Every workflow's setup screen has a **Models** card above the graph. It only ever changes which
model an agent runs, so it works for templates (Discover, Improve, Find the best, Decide,
Investigate) and for described workflows alike. Jira: OAOS-9.

## What a person can do

- **Tier for every step, or for one step.** Cheap, Standard, Frontier. A tier is an ordered
  lineup of models; a one-agent step gets the first, a step with more agents takes the next ones
  in order, so families stay mixed. Steps that decide (review, rank, synthesize) skip
  Google-family models, and a review or rank step leads with the families that did not write
  what it judges, so a one-agent judge on the same tier as the work still comes from another
  family. A step the lineup has no model for is left as it was and named.
- **Each agent's own model**, one click on its chip. The list holds the signed-in families, the
  Ollama models on this computer, and OpenRouter's catalog with a price filter: Free, Very low
  cost (at most $0.10 in and $0.50 out per 1M tokens), Low cost (at most $0.50 in and $2 out), All.
- **Combo.** Tick models from any providers and the step runs exactly one agent on each (up to 8;
  a Synthesize step keeps one). Angles and system prompts carry over in order and repeat. This is
  how Discover's finders run on, say, Claude, GPT, Grok, an OpenRouter model and a local one.
- **Say it.** "Cheap models for the research, frontier for the report, the finders on Claude, GPT
  and a free OpenRouter model." One read-only Claude call answers with a plan that can only change
  models (`workflow-model-plan.ts`); what changed is read back step by step with any assumption.
  The full "describe a workflow" compiler understands the same tier words when it builds a graph.
- **Adjust tiers.** Add or remove models per tier; saved for every workflow on this computer
  (`workflowModelTiers` in the profile), with "Back to built-in tiers".
- **CLI and agents:** `omni workflow run --models`:
  - `--models cheap` puts every step on the Cheap tier;
  - `--models "*=cheap;report=frontier"` sets tiers by step (`*` is every step not named);
  - `--models "find=claude:opus,codex,grok,openrouter:deepseek/deepseek-v4-flash,ollama:qwen3:8b"`
    is a combo on one step. A model is `<route>` (the family's default) or `<route>:<model>`.

Logos: a signed-in family keeps its icon; a model reached through OpenRouter or Ollama shows the
mark of the company that made it (`workflow-model-logo.tsx`, marks bundled inline in
`model-maker-glyphs.ts`), so the same model reads the same whichever route runs it.

## Built-in lineups

| Tier     | Models                                                    |
| -------- | --------------------------------------------------------- |
| Cheap    | Claude Haiku 5.5, GPT-6 Luna, Gemini 3.8 Flash            |
| Standard | Claude Sonnet 5.5, GPT-5.6 Sol, Grok 4.6                  |
| Frontier | Claude Opus 5.5 (the default seat), GPT-6 Astra, Grok 4.6 |

The Cheap tier's Haiku 5.5 needs Claude Code 2.1.293 or later on the computer that runs it; an
older CLI is refused by name rather than switched to another model. `claude:haiku` is still the
CLI's `haiku` alias, Haiku 4.5. Until 2026-10-12 the Opus and Sonnet seats were pinned to
`claude-opus-5` and `claude-sonnet-5`, which run Opus 5 and Sonnet 5; runs frozen with those ids
still resume on them, and they are no longer offered.

OpenRouter and Ollama models are not in the built-in lineups, because which ones exist changes by
the week and by the computer: add them under Adjust tiers (the Cheap tier's list opens on Free).
A step's tier is never stored. It is read back from the models its agents run
(`workflowStepTier`), so the workflow format, saved tabs and older hosts are unchanged. A model in
two lineups (Grok 4.6) reads as the stronger tier. On Find the best and Improve, models a person
chose (a tier, a combo, a pick) stay when another option changes; only families left on their
defaults are rebuilt from the rotation.

## What is new on the host

- **Claude Haiku seats.** `haiku` → `claude-haiku-4-5-20251001`, measured 2026-10-04 on CLI 2.1.285
  (`modelUsage` reports that exact key). No effort option. `claude-haiku-5-5` reports that exact
  key (2026-10-12, CLI 2.1.292) and offers low, medium and high effort, high by default.
- **Ollama route** (`ollama`). Installed tags are read from `/api/tags`, with `/api/show` for
  tool support and the model's own context limit. Like OpenRouter it has no default model: a seat
  names a tag. The family is read from the model name only (`qwen3:8b`, `hf.co/org/Llama-…`), and a
  model whose family this build cannot place is not offered (the same rule as everywhere else).
- **Worker** (`workflow-ollama-worker.ts`): Ollama's native `/api/chat`, because only it sets the
  context per call. The OpenAI-compatible endpoint cuts a long prompt to the server default without
  saying so. It emits the same lines as the OpenRouter worker, so one parser, attestation and live
  view read both. Workspace reads use the same three read-only tools.
  - **Context** (`workflowOllamaCallContext`): `num_ctx` is the smallest step that holds the
    prompt, an 8,192-token answer and, for a workspace read, 24,000 tokens of file content. A model
    with a smaller limit keeps what fits (a shorter answer, less to read); one that cannot read the
    prompt whole is refused by name, before the run starts where that is already knowable.
  - **Nothing dropped silently.** Ollama drops the oldest messages, the task first, once a
    conversation outgrows its context, and reports nothing (measured: a 4,959-token conversation
    at `num_ctx` 4,096 answered from the wrong message with `done_reason: stop`). So the worker
    counts what the tools bring in, cuts a result to the room left, and asks for the answer when
    the room is used.
  - **Transport** is `node:http`, not `fetch`: `fetch` ends any reply slower than five minutes,
    and a call may wait longer than that behind other local calls. Frozen calls get 15 minutes by
    default, workspace reads 30.
  - **A runtime that cannot constrain output** (Ollama's MLX models answer HTTP 501 to a schema)
    is asked for the schema in words, and the JSON is cut out of the fence the model wraps it in.
    The host validates the answer against the schema as for every route.
  - **A model stuck thinking** ends at the answer limit with "ran out of room to answer: the model
    may be stuck thinking", and the run's own retry rules apply.
- No follow-up chat on an Ollama or OpenRouter synthesizer, as before for OpenRouter.

## Measured on this MacBook, 2026-10-04

- `npx --yes tsx config/scripts/workflows/probe-ollama.ts`: the shipped worker script on a real
  local 4B Qwen returned a schema answer in 1.2 s; an MLX Gemma, which refuses schemas, answered
  through the plain-words fallback in 1.1 s; with `--workspace` a 35B Qwen read a file through the
  tools and answered correctly in 4.9 s. The 4B model guessed a wrong path on the same read and
  gave up, which the worker bounds: a small model can be a poor workspace reader.
- The same 4B model twice spent a 16,384-token answer limit thinking (196 s, no answer), and
  answered in 2 s on other tries. That is why the answer limit is 8,192 and why that failure has
  its own message.
- A real Council through a dev build of the final code, started with
  `--models "*=cheap;answer=claude:haiku,openrouter:qwen/qwen3.8-27b:free,ollama:<a local Qwen>,ollama:gemma4:e2b-mlx"`:
  completed with no gaps in 1 min 4 s. Answers came from `claude-haiku-4-5-20251001` (5.4 s),
  `qwen/qwen3.8-27b:free` (21.3 s), the local Qwen (4.4 s) and the MLX Gemma (8.0 s); GPT-6 Luna
  and Haiku ranked; Haiku chaired. The first commit's run (three answerers) took 2 min 10 s.
- OpenRouter's live catalog that day: 466 models, 22 free, 6 of those return structured answers
  and 2 are from a family this build knows, so 2 free models can take a seat. 110 models are at
  most $0.50 in and $1.50 out per 1M and seatable.

Receipts and screenshots: `docs/workflows/evidence/model-tiers-2026-10-04/`.

## Limits

- Free OpenRouter models are few and rate-limited by OpenRouter; a run that loses one says so in
  its gaps like any other lost call.
- A local model's answer quality and tool use are its own. Nothing here measures whether a cheap
  or local lineup finds as much as the default one: that needs the quality cases in
  `config/scripts/workflows/`, per model.
- Reading web pages is not offered with Ollama models (not measured), as with OpenRouter.
- Ollama, OpenRouter, Grok and Gemini seats run on this computer only. A run placed on another
  fleet host seats Claude and Codex there and refuses the others by name
  (`docs/reference/workflow-fleet-placement.md`): choose "Run on: this computer", or
  `--runs-on local`, for a combo that includes them.
- Windows has no workflow process adapter, so no Ollama seat either.
