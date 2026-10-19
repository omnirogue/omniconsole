# Multi-model coding cookbook

This cookbook shows how to code with **Claude Opus 5.5**, **GPT-6 Astra**,
**Gemini 4 Argon**, and **Kimi K3** from one OmniConsole workspace. It covers the
OmniRogue Gateway, in-session model switching, cross-model handoffs, and the
checks to run before spending credits.

It describes the contracts in this source snapshot, reviewed on **2026-10-16**.
Model availability, prices, and CLI behavior depend on your desktop build, your
connected account, the installed CLI versions, and the hosted gateway
deployment. The gateway's `/v1/models` response and each CLI's own model list are
authoritative for your setup. This document makes no benchmark claims.

New to OmniRogue? Start with the [connector guide](OMNIROGUE-CONNECTOR-GUIDE.md),
then come back here.

## Contents

- [The four models at a glance](#the-four-models-at-a-glance)
- [How routing works](#how-routing-works)
- [Before you start](#before-you-start)
- [The terminal model switcher](#the-terminal-model-switcher)
- [Per-model notes](#per-model-notes)
- [Recipes](#recipes)
- [Choosing a starting model](#choosing-a-starting-model)
- [Guardrails](#guardrails)
- [Troubleshooting](#troubleshooting)
- [Source anchors](#source-anchors)

## The four models at a glance

| Model | Model ID | CLI agent | Through the OmniRogue Gateway (this snapshot) | Switch inside a running session | Reasoning control |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5.5 | `claude-opus-5-5`; 1M-token window: `claude-opus-5-5[1m]` | Claude | Listed. Claude launches receive Anthropic-compatible variables. | Type `/model claude-opus-5-5` | `--effort` at launch, `/effort` mid-session |
| GPT-6 Astra | `gpt-6-astra` | Codex | Listed. Codex launches receive OpenAI-compatible variables. | Typed `/model` opens Codex's picker; OmniConsole applies a pick by resuming the thread with `-m` | `-c model_reasoning_effort=<level>`, applied by resuming |
| Gemini 4 Argon | `gemini-4-argon` | Gemini, or OpenCode for gateway billing | Listed. Gemini CLI launches receive **no** gateway credentials; use OpenCode to bill Argon to credits. | Typed `/model` opens Gemini's picker | None in the OmniConsole catalog |
| Kimi K3 | `moonshot-ai/kimi-k3` (onboarding picker); `moonshotai/kimi-k3` (OpenRouter) | Kimi, or OMP through OpenRouter | **Not listed.** Use Kimi's own login, or OMP with your OpenRouter key. | Kimi's own controls, or relaunch | Kimi's own controls |

"Listed" means the model ID appears in the gateway's model catalog that this
build expects and checks. Your deployment's catalog can differ; see
[Recipe 1](#recipe-1-preflight-all-four-models).

## How routing works

### Two billing routes

The **Primary AI** preference holds an agent, an optional model, and one of two
billing routes:

| Route | Setting value | Badge in the terminal header | What pays |
| --- | --- | --- | --- |
| OmniRogue Credits (Unified Gateway) | `omnirogue-credits` | **Gateway** (amber) | Your OmniRogue credit balance, through `api.omnirogue.com` |
| Own CLI Login | `own-login` | **Own Login** | Your provider subscription or API account, through the CLI's own login |

The route is **one preference for the whole app**, and it is read when an agent
launches. A running CLI keeps the environment it started with. Changing the route
therefore changes only the agents you launch afterward. That rule is what makes
[mixed-route workspaces](#recipe-7-mixed-routes-kimi-k3-on-own-login-beside-gateway-sessions)
possible.

### What OmniConsole injects at launch

When the route is `omnirogue-credits` **and** the app holds a valid leased
OmniRogue gateway token, it adds these variables to the agent's environment:

| Agent being launched | Variables added |
| --- | --- |
| Every agent | `OMNIROGUE_BILLING_MODE=omnirogue-credits`, `ORCA_OMNIROGUE_GATEWAY_ACTIVE=1`, `ORCA_OMNIROGUE_BILLING_MODE`, `OMNIROGUE_GATEWAY_BASE_URL`, and `OMNIROGUE_MODEL` when a model is saved |
| Claude | `ANTHROPIC_BASE_URL` (the gateway base URL), `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` |
| Codex, OpenCode, and other agents except Claude and Gemini (this includes Kimi) | `OPENAI_BASE_URL` (the gateway base URL plus `/v1`), `OPENAI_API_KEY` |
| Gemini | No provider credential variables |

If the token is missing or invalid, nothing is injected and the CLI falls back to
its own login. The switcher then shows **Sign in to OmniRogue for gateway
routing** instead of **obp_ token ready**.

The token is leased, scoped, and expires. The app manages it. Do not copy it out of
a terminal environment into scripts, prompts, or issue reports.

The gateway base URL comes from the linked account's API origin. If that is
unavailable, the app uses `OMNIROGUE_GATEWAY_BASE_URL`, and then
`https://api.omnirogue.com`. Ordinary use needs no override.

### Where the model list comes from

When the app builds a gateway session, it requests `/v1/models` from the gateway.
It keeps entries whose provider is Anthropic, OpenAI, or Google, so Kimi K3 is
dropped from the desktop list even if a deployment were to return it. If the
request fails or returns nothing usable, the switcher shows a built-in fallback
list: Claude Opus 5.5, Claude Sonnet 4.6, Claude Haiku 5.5, GPT-6 Astra, GPT-5.4,
Gemini 4 Argon, and Gemini 3.8 Flash.

**The fallback list is not proof of availability.** Treat a model as available
only when your preflight shows it in the gateway catalog and a first request
succeeds.

## Before you start

1. **Connect your OmniRogue account** and choose a Primary AI. See the
   [connector guide](OMNIROGUE-CONNECTOR-GUIDE.md).
2. **Install and sign in to each CLI on the computer that runs it.** You need
   `claude`, `codex`, `gemini`, and `kimi`. Install `opencode` if you want Argon on
   gateway credits, or `omp` if you want Kimi K3 through OpenRouter. A shared
   worktree does not share CLI login state between computers.
3. **Run OmniRogue diagnostics.** Open the OmniRogue diagnostics card in Settings.
   It reports four stages:

   | Stage | Passes when |
   | --- | --- |
   | Account Link & Token Lease | The account is linked and a gateway token can be leased |
   | Unified Credit Wallet | The balance can be read |
   | Unified MCP | `app.omnisi.ai/mcp` and `api.omnirogue.com/mcp` respond |
   | Multi-Model LLM Gateway | `/v1/models` lists `claude-opus-5-5`, `gpt-6-astra`, **and** `gemini-4-argon` |

   The gateway stage is **skipped** on Own Login. It fails with
   `Missing frontier models: …` if any of the three is absent. Kimi K3 is not part
   of this check.
4. **Check the header badge.** Open the model switcher on a terminal tab and
   confirm **Gateway** with **obp_ token ready**, or **Own Login**, matches what
   you intend to pay with.

## The terminal model switcher

Each terminal tab group's header has a model button. It shows the current model
label and a **Gateway** or **Own Login** badge. Opening the menu refreshes the
gateway session. The menu has two sections.

### Billing & Routing

Select **OmniRogue Credits (Unified Gateway)** or **Own CLI Login**. The choice is
saved immediately. The menu then shows **Billing & gateway URL changes apply on
next CLI session launch**. Running sessions are not rerouted.

### Models

The list comes from the gateway catalog, or the fallback list. When you select a
model, OmniConsole:

1. Saves the Primary AI preference. The agent is the one detected in the active
   pane, if any; otherwise it is the model's recommended agent.
2. Tells the main process about the switch, which updates `OMNIROGUE_MODEL` for
   future launches.
3. Types `/model <id>` followed by Enter into the active terminal, **only if** a
   live agent is detected in the pane **and** the catalog entry is marked as
   supporting a slash-command switch.

Read the confirmation line at the bottom of the menu:

| Confirmation | What happened |
| --- | --- |
| `Sent /model <id> to active session` | The command was typed into the running CLI. Check the CLI's own confirmation. |
| `Saved <model> for next session` | The preference was saved. **The running CLI is unchanged.** |

In this snapshot, neither the gateway catalog mapping nor the fallback list
marks any model as supporting a slash-command switch. Expect **Saved … for next
session** unless your deployment adds that flag. The header hint can still say
that selecting a model sends `/model` immediately. Trust the confirmation line,
then switch inside the CLI yourself as described in [Per-model
notes](#per-model-notes).

If a terminal is open but no agent is detected, the menu offers
**Send `/model <id>` to terminal now**. Use it only when the foreground program understands
`/model`. Otherwise the text is typed into whatever is running, such as a shell.

> **Stay inside one model family per pane.** The switcher keeps the pane's
> detected agent. Selecting `gpt-6-astra` while a Claude pane is active saves the
> mismatched pair `claude` + `gpt-6-astra`. To change families, open a new
> terminal with the other agent and hand off the task as in
> [Recipe 3](#recipe-3-plan-with-one-model-implement-with-another).

## Per-model notes

### Claude Opus 5.5 (Claude CLI)

**Launch**

```bash
claude --model claude-opus-5-5 --effort high
```

On the gateway route, OmniConsole supplies the Anthropic-compatible variables, so
you add only the model and effort. The Claude CLI also accepts the family aliases
`fable`, `opus`, `sonnet`, and `haiku`, which resolve to the newest model in that
family **on the installed CLI version**. Use the full ID when you need a pinned
model.

**Switch in session**

```text
/model claude-opus-5-5
/effort xhigh
```

Claude can ask for confirmation when a switch affects cached conversation
history. Answer that prompt in the terminal before sending your next request.
Where the model advertises fast mode, `/fast` toggles it.

**Effort levels**

The levels are `low`, `medium`, `high`, `xhigh`, and `max`, limited to those
the CLI advertises for the model. OmniConsole's effort picker defaults to `high`.

**Long context**

Request the 1M-token window explicitly with `claude-opus-5-5[1m]`, if your route
supports it. OmniConsole workflows budget plain Claude IDs at 200k tokens and the
`[1m]` variant at 1M.

### GPT-6 Astra (Codex CLI)

**Launch**

```bash
codex -m gpt-6-astra -c model_reasoning_effort=high
```

On the gateway route, Codex receives `OPENAI_BASE_URL` and `OPENAI_API_KEY`.

**Effort levels for Astra**

The levels are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`.
If you do not pick a level, OmniConsole leaves your Codex `config.toml` value in
effect. It does not impose its own default.

**Switch in session**

Codex has no `/effort` command, and its typed `/model` opens an interactive
picker. When you change Astra's model or effort from OmniConsole's session
controls, the app **resumes the same Codex thread** with the new `-m` or
`-c model_reasoning_effort=` arguments. Expect the Codex process to restart and
the conversation to continue from Codex's saved thread. Let any running turn
finish first.

### Gemini 4 Argon (Gemini CLI or OpenCode)

**Launch on your own Google login**

```bash
gemini -m gemini-4-argon
```

OmniConsole's default for new Gemini sessions is `gemini-3.8-flash`, so select
Argon explicitly. Inside the session, `/model` opens Gemini's own picker. Some
Gemini CLI versions silently substitute a model they do not recognize. Confirm the
model the CLI reports before relying on a result.

**Bill Argon to OmniRogue credits**

In this snapshot, a Gemini CLI launch receives no gateway credentials, even on
the credits route. It runs on your own Google login. To bill Argon through the
gateway, launch **OpenCode**. It is the recommended agent for every gateway model
and receives the OpenAI-compatible variables:

```bash
opencode --model <provider>/gemini-4-argon
```

OpenCode's model list comes from its own merged configuration. Declare an
OpenAI-compatible provider there that reads `OPENAI_BASE_URL` and
`OPENAI_API_KEY`, and use that provider's name as `<provider>`. OpenCode has no
typed in-session model command. Use its own picker or relaunch with a different
`--model`.

**Long context**

OmniConsole workflows budget Gemini models at a 1M-token window.

### Kimi K3 (Kimi CLI, or OMP through OpenRouter)

**On Kimi's own login (recommended)**

Sign in with the Kimi CLI on the execution computer. Its state lives in
`~/.kimi-code`, or in `KIMI_CODE_HOME` if you set it. OmniConsole reads Kimi rate
limits for its status bar. It has no model catalog for Kimi, so change models with
Kimi's own controls or by relaunching.

**Do not launch Kimi on the credits route.** The gateway does not list Kimi K3.
However, on the credits route, OmniConsole adds OpenAI-compatible gateway
variables to every agent except Claude and Gemini, and that includes Kimi. If
your Kimi CLI reads those variables, it would send requests to a gateway that
does not serve the model. Switch to **Own CLI Login** before launching Kimi, as
in [Recipe 7](#recipe-7-mixed-routes-kimi-k3-on-own-login-beside-gateway-sessions).

**Through OpenRouter with OMP**

The new-conversation launcher defaults OMP to `openrouter/moonshotai/kimi-k3`.
This route bills **your OpenRouter account**, not OmniRogue credits. It needs an
OpenRouter key available to OMP. OMP thinking levels are set at launch with
`--thinking`; OMP documents no in-session setter.

## Recipes

Each recipe lists the route it assumes. Model choices are suggestions; swap in
whichever listed model fits your task and budget.

### Recipe 1: Preflight all four models

**Route:** both. **Time:** about five minutes.

1. Run OmniRogue diagnostics (see [Before you start](#before-you-start)). On the
   credits route, the gateway stage should pass.
2. Open the terminal model switcher. Confirm the three gateway models appear,
   and confirm the badge and token status.
3. In each CLI, send a trivial prompt, for example "Reply with the model you are
   running as." Check the model the CLI itself reports, not only the answer text.
4. If you call the gateway from your own tooling (see
   [Recipe 8](#recipe-8-call-the-gateway-from-your-own-scripts)), list the
   catalog directly:

   ```bash
   curl -sS https://api.omnirogue.com/v1/models \
     -H "Authorization: Bearer $OMNIROGUE_API_KEY" | jq -r '.data[].id'
   ```

   Here `OMNIROGUE_API_KEY` is your own variable holding an OmniRogue key issued
   for direct API use. It is **not** the app's leased token.
5. Stop and fix any gap before starting real work. Do not let a missing model be
   silently replaced by another.

### Recipe 2: Change models inside one session

**Route:** either. **Use when:** you want a cheaper or stronger model for the next
step without losing the conversation.

Claude example: plan on Opus 5.5, then do mechanical edits on Haiku 5.5.

```text
/model claude-opus-5-5
# …agree the plan…
/model claude-haiku-5-5
# …apply the mechanical edits…
/model claude-opus-5-5
/effort xhigh
# …review the result…
```

Codex example: lower Astra's effort for a routine step. Pick the new effort in
OmniConsole's session controls and let the app resume the thread. Raise it again
before the difficult part.

Rules:

- Switch between turns, not during one.
- After each switch, confirm the active model in the CLI.
- Stay in the pane's model family. For another family, use Recipe 3.

### Recipe 3: Plan with one model, implement with another

**Route:** either. **Use when:** one model should design and a different family
should build.

Example: Opus 5.5 plans and GPT-6 Astra implements, in the same worktree.

1. In the Claude pane, ask for a written plan: files to change, interfaces,
   acceptance checks, and risks.
2. Ask Claude to stop editing. One writer per worktree at a time.
3. Open a new terminal tab in the same worktree and launch Codex with
   `gpt-6-astra`.
4. Paste a handoff. Transcripts do not move between providers, so the handoff
   must stand on its own:

   ```markdown
   ## Handoff
   Goal: <one sentence>
   Constraints: <must/must not; style rules; files out of scope>
   Plan: <numbered steps from the planning model>
   State: <files already changed, branch, last commit>
   Decisions made: <choice + reason>
   Next step: <the first concrete action>
   Done when: <command(s) that must pass>
   ```

5. Let Astra implement and run the stated checks.
6. Optionally return to the Claude pane for review (Recipe 4).

Keeping the workspace keeps the files. It does not carry provider-side context.

### Recipe 4: Cross-family review

**Route:** either. **Use when:** you want a second family to check one family's
work before you merge.

1. Commit or stage the implementation so the diff is stable.
2. Open a pane with a different family from the implementer. For example, Opus
   5.5 reviews Astra's work, or Argon reviews Opus's work.
3. Prompt for a read-only review:

   ```text
   Review the diff from <base>..HEAD. Do not edit files.
   Report correctness bugs first, each with the file:line, a concrete failing
   input or sequence, and the expected vs actual behavior. Then list missing
   tests. Mark anything you are unsure of as uncertain.
   ```

4. Take findings back to the implementer's pane, or fix them yourself. Re-run
   the checks.
5. Treat a disagreement between models as a prompt to reproduce the case, not as
   a vote.

### Recipe 5: Parallel attempts in separate worktrees

**Route:** either. **Use when:** a task is ambiguous enough that comparing two or
three independent solutions is worth the extra spend.

1. Create one worktree per model from the same base commit.
2. Give every model the **identical** brief, including the acceptance commands.
3. Launch Opus 5.5, Astra, and Argon each in its own worktree. Never run two
   writing agents in the same worktree.
4. Compare the results on evidence: acceptance checks, diff size, and a
   [cross-family review](#recipe-4-cross-family-review) of each finalist.
5. Keep one result and delete the other worktrees.

On the credits route, each attempt spends separately, so three attempts cost
roughly three times as much. Check your balance before fanning out.

### Recipe 6: Read the whole codebase, then hand off a narrow task

**Route:** either. **Use when:** the task needs a broad read of a large codebase
before a small, precise change.

1. Use a long-window reader: `gemini-4-argon`, or `claude-opus-5-5[1m]` where
   your route supports it.
2. Ask for a map, not edits: the relevant files and symbols, call paths,
   invariants, and the smallest change that satisfies the goal.
3. Hand that map to an implementer with a standard window, as in
   [Recipe 3](#recipe-3-plan-with-one-model-implement-with-another). Include the
   exact file paths so it does not need to read everything again.

### Recipe 7: Mixed routes (Kimi K3 on Own Login beside gateway sessions)

**Route:** mixed. **Use when:** you want Kimi K3 working next to gateway-billed
Claude and Codex sessions.

Because the billing route is read at launch, set it before each launch:

1. Set **OmniRogue Credits (Unified Gateway)**. Launch the Claude (Opus 5.5) and
   Codex (Astra) panes. Confirm the **Gateway** badge.
2. Switch to **Own CLI Login**. The running Claude and Codex sessions keep their
   gateway environment.
3. Launch Kimi in its own pane or worktree. It uses your Kimi login.
4. Before launching anything else, switch back to the route you want new panes
   to use.

The badge reflects the **saved preference**, not each running process. Record
which pane uses which route. Relaunch a pane if you are unsure.

### Recipe 8: Call the gateway from your own scripts

**Route:** credits, using your own OmniRogue key for direct API use. **Use when:**
a script, CI job, or tool outside OmniConsole needs the same models.

Mirror what OmniConsole injects. Use an OpenAI-compatible client at the `/v1`
base, and an Anthropic client at the gateway base URL:

```bash
export OPENAI_BASE_URL="https://api.omnirogue.com/v1"
export OPENAI_API_KEY="$OMNIROGUE_API_KEY"        # reference your vault variable; never paste a value

export ANTHROPIC_BASE_URL="https://api.omnirogue.com"
export ANTHROPIC_API_KEY="$OMNIROGUE_API_KEY"
```

```python
import os
from openai import OpenAI

client = OpenAI(base_url=os.environ["OPENAI_BASE_URL"], api_key=os.environ["OPENAI_API_KEY"])

available = {m.id for m in client.models.list().data}
for model in ("gpt-6-astra", "gemini-4-argon"):
    if model not in available:
        raise SystemExit(f"{model} is not in this gateway's catalog; refusing to substitute")

reply = client.chat.completions.create(
    model="gpt-6-astra",
    messages=[{"role": "user", "content": "Summarize the risk in this diff: ..."}],
)
print(reply.choices[0].message.content)
```

Notes:

- `/v1/models` is the route this build relies on. Confirm that your deployment
  serves the request type you use, such as Chat Completions or Anthropic Messages,
  before you depend on it.
- Direct API keys and account-authorized connections can draw from different
  balances. Read the billing source the service reports.
- Do not retry a write on timeout without checking its outcome first.

### Recipe 9: See what each model cost

**Route:** credits.

- The OmniRogue usage item in the status bar summarizes recorded credits by
  model and capability, including prompt-cache savings where they are reported.
- For an auditable figure, use `credits_receipt` with
  `"capabilities": ["llm-gateway"]` and your session or run ID, if your
  deployment lists that tool. It is an opt-in integration-stage tool; see the
  [MCP reference](UNIFIED-MCP-REFERENCE.md). Unknown values are reported as null,
  not as zero.
- Reserved credits and settled spend are different numbers. Do not add them
  together.

## Choosing a starting model

OmniConsole's default workflow tiers are a reasonable starting lineup. They are a
starting point, not a ranking.

| Tier | Default lineup |
| --- | --- |
| Frontier | Gemini 4 Argon, Claude Opus (`opus`), GPT-6 Astra, Grok 4.6 |
| Standard | Claude Sonnet (`sonnet`), GPT-5.6 Sol, Grok 4.6 |
| Cheap | Claude Haiku 5.5, GPT-6 Luna, Gemini 3.8 Flash |

Kimi K3 is not in the default tiers. Add it from OpenRouter if you want it there.
Evaluate on your own repository: run the same brief and acceptance checks across
models (Recipe 5), and keep notes on which model handled which kind of change.

## Guardrails

- **Credentials.** Never paste the leased `or_obp_` token, a provider key, or an
  OmniRogue API key into prompts, repository files, screenshots, or issue
  reports. Reference environment variables, not values.
- **Spend.** Parallel sessions spend in parallel. Read the balance, including
  reserved credits, before fanning out.
- **No silent substitution.** If a requested model is missing or rejected, stop
  and choose another model deliberately. Record the change.
- **One writer per worktree.** Readers and reviewers can share a worktree;
  writers cannot.
- **Unknown outcomes.** A timeout is not proof that a request failed. Keep the
  request ID and reconcile before resubmitting.

## Troubleshooting

| Symptom | Likely cause and next step |
| --- | --- |
| Badge says **Gateway**, but the CLI uses your own subscription | The pane launched before you switched routes, the token is missing (**Sign in to OmniRogue for gateway routing**), or the agent is Gemini, which receives no gateway credentials. Reconnect if needed, then relaunch the pane. |
| Picking a model shows **Saved … for next session** | Expected in this snapshot. Switch inside the CLI (`/model` for Claude; session controls for Codex) or relaunch. |
| Diagnostics: `Missing frontier models: …` | The deployment's catalog lacks that model. Retry later, or use Own Login for that model. Do not substitute silently. |
| Kimi K3 is not in the switcher | Expected. The gateway does not list it and the desktop list keeps only Anthropic, OpenAI, and Google models. Use Kimi's own login or OMP. |
| Codex restarted after a model or effort change | Expected. OmniConsole applies Codex changes by resuming the thread with new arguments. |
| Gemini reports a different model than requested | The CLI substituted an ID it does not recognize. Update the CLI or pick an ID it lists. |
| Claude asks for confirmation after `/model` | The switch affects cached history. Answer the prompt, then continue. |
| Gateway returns 401 | The token lease expired or the account was unlinked. Reconnect in the app, then relaunch the pane. |
| Saved preference shows a mismatched agent and model | A cross-family model was picked in a live pane. Pick a model from the pane's family, or open a pane with the right agent. |
| Text such as `/model …` appeared at a shell prompt | **Send /model … to terminal now** was used with no agent in the foreground. Clear the line and launch the agent first. |

When you report a problem, include the app version, operating system, agent and
CLI version, model ID, route, sanitized error, and request or run ID. Never
include tokens.

## Source anchors

These files describe this checkout, not a particular hosted deployment:

- Gateway session, model switch, and billing IPC:
  [`omnirogue-gateway-ipc.ts`](../../src/main/ipc/omnirogue-gateway-ipc.ts)
- Launch-time variable injection:
  [`omnirogue-gateway-env.ts`](../../src/main/runtime/omnirogue-gateway-env.ts)
- Gateway catalog fetch and fallback:
  [`omnirogue-gateway-models.ts`](../../src/main/omnirogue-account/omnirogue-gateway-models.ts),
  [`omnirogue-account.ts`](../../src/shared/omnirogue-account.ts)
- Terminal model switcher:
  [`ModelSwitcherDropdown.tsx`](../../src/renderer/src/components/terminal/ModelSwitcherDropdown.tsx)
- Per-agent model and effort controls:
  [`agent-session-option-catalog-claude-codex.ts`](../../src/shared/agent-session-option-catalog-claude-codex.ts),
  [`agent-session-option-catalog-gemini-cursor.ts`](../../src/shared/agent-session-option-catalog-gemini-cursor.ts),
  [`agent-session-option-catalog-opencode.ts`](../../src/shared/agent-session-option-catalog-opencode.ts),
  [`agent-session-option-catalog-omp.ts`](../../src/shared/agent-session-option-catalog-omp.ts)
- Onboarding model list:
  [`use-onboarding-flow-types.ts`](../../src/renderer/src/components/onboarding/use-onboarding-flow-types.ts)
- Diagnostics: [`omnirogue-doctor.ts`](../../src/main/omnirogue-account/omnirogue-doctor.ts)
- Workflow tiers and context windows:
  [`workflow-model-tiers.ts`](../../src/shared/workflow-model-tiers.ts),
  [`workflow-model-context-window.ts`](../../src/shared/workflow-model-context-window.ts)
- OMP default model: [`omp-launch-model.ts`](../../src/shared/omp-launch-model.ts)

Related guides: [connector guide](OMNIROGUE-CONNECTOR-GUIDE.md),
[unified MCP reference](UNIFIED-MCP-REFERENCE.md),
[hosted Evolve guide](HOSTED-EVOLVE-SUPER-INTELLIGENCE.md).
