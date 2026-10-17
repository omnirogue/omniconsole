# Connect OmniRogue to OmniConsole

OmniConsole can use your OmniRogue account for hosted AI and media tools, or your
own provider login for local CLI agents. This guide describes the onboarding and
account contracts in this source snapshot, reviewed on **2026-10-16**. Availability
depends on the desktop build, connected account, and hosted service deployment.

## First launch: create or connect an account

1. Open OmniConsole. The first onboarding step is **Create or Connect your
   OmniRogue Account (Recommended)**.
2. If you already have an account, select **Connect OmniRogue Account** and
   complete the browser sign-in using that account.
3. If you are new, select **Create OmniRogue Account**. This opens
   [OmniRogue sign-up](https://omnirogue.com/signup). Complete registration, return
   to OmniConsole, and connect the account.
4. Complete the browser authorization and return through its app callback. If
   your build offers a manual authorization-code fallback, paste the code only
   into that connection dialog. A code is not a provider API key.
5. Wait for **Connected to OmniRogue** and check the displayed identity before
   starting paid work. Finish the Primary AI step and the remaining onboarding
   preferences.

You can skip linking when using your own local CLI login. Account linking is
required for hosted operations that use the OmniRogue wallet. Creating an account
does not by itself guarantee included credits or access to every model.

The app manages the connection credential and provisions its supported MCP
connections for agent launches. Do not paste credentials into prompts, repository
configuration, screenshots, or issue reports. On another computer, authenticate
through its supported connection flow; a shared worktree does not share provider
login state.

## Choose your Primary AI

In **Choose your Primary AI & Default Model**, select a billing route and a
flagship model. The selected model also selects its associated CLI agent.

| Display name | Model identifier in the picker | Agent |
| --- | --- | --- |
| Claude Opus 5.5 | `claude-opus-5-5` | Claude |
| GPT-6 Astra | `gpt-6-astra` | Codex |
| Gemini 4 Argon | `gemini-4-argon` | Gemini |
| Kimi K3 | `moonshot-ai/kimi-k3` | Kimi |

The picker may offer additional models. Select a model actually available to
your account and installed CLI version. A display entry is not a guarantee that
every billing route supports it. In this snapshot the gateway's advertised
models include Opus 5.5, Astra, and Argon; Kimi K3 is in onboarding but absent
from that gateway catalog. Use Kimi's own login until the gateway advertises
support for that model.

Primary AI is the saved default for new launches. Model preferences and
reasoning-effort preferences are separate. Check the active session's provider,
model, and account after launching.

## Unified credits or BYOK

| Route | Setup | What pays |
| --- | --- | --- |
| **OmniRogue Cloud Credits (Recommended)** | Connect OmniRogue and select a supported gateway model. | The balance and billing mode returned by the hosted service. |
| **Use my own local CLI login** | Install and authenticate the selected CLI on the execution computer. | Your provider subscription or API account, according to its terms. |
| **BYOK through a local CLI** | Configure your provider API key using that CLI's supported secure configuration. Select the own-login route. | Your provider API account. |

BYOK means **bring your own key**. A provider API key and a provider subscription
are different billing arrangements, even though both use the own-login route.
Do not insert a provider key into the OmniRogue account-link dialog.

The OmniRogue gateway uses `https://api.omnirogue.com/v1` for supported
OpenAI-compatible requests and `/anthropic` for supported Anthropic-compatible
requests. OmniConsole supplies the launch environment for its supported
integrations; manual gateway overrides are not needed for ordinary onboarding.
The gateway's HTTP inference routes are separate from MCP tools.

Using your own login for coding does not make hosted Evolve, Discover, or media
generation free. Those operations have their own quotes and account checks.
Direct API keys may use an API wallet while account-authorized connections use
account credits. Read the returned balance, billing source, and quote instead of
assuming all credential types spend the same balance.

## Switch models and billing routes

1. Save your work and let the active operation reach a safe stopping point.
2. Use the session's model control in the composer or terminal header where
   available. Choose the new model from that agent's supported catalog.
3. To change model family, select the corresponding agent in the same workspace.
   Supply a short handoff describing the task, changed files, and next step if
   the new provider does not support resuming that conversation.
4. Check the active provider and model before submitting the next prompt. Keeping
   the same workspace preserves files; it does not promise portable transcripts
   or identical provider-side context.
5. To change the default for future work, update the Primary AI preference in the
   app's account/AI settings where your build exposes it.

A saved preference is not proof that an already-running CLI changed its model.
Use the CLI's supported model-switch control or start a new session if needed.
**Changing the billing route requires a new agent launch** in the current
gateway contract, because an existing process retains its launch environment.
Verify the new route after relaunching.

## Check the connection before spending

Open the app's MCP connector settings and check the configured HTTPS endpoints:

- `https://app.omnisi.ai/mcp` — unified credits, media adapters, and Super
  Intelligence workflows, plus collaboration tools.
- `https://api.omnirogue.com/mcp` — direct OmniRogue model discovery, generation,
  and media workflow tools.

Use a read-only identity or balance tool to confirm the connection. On OmniSI,
discover `whoami` and `credits_balance`; on OmniRogue, discover `get_profile` and
`get_credits`. Tool availability is returned by the server's `tools/list`.

For paid work, inspect the model schema, obtain the relevant quote, and use a
spending cap or confirmation flow supported by that tool. Preserve the original
request ID after submission. A timeout does not mean a generation failed or that
it is safe to submit a replacement.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Browser sign-in finishes, app remains disconnected | Return to the original connection dialog; use its callback or offered code fallback. Retry linking if the attempt expired. |
| Wrong account displayed | Disconnect through the app and reconnect with the intended account before spending. |
| CLI is missing or unsigned-in | Install/authenticate that CLI on the computer actually running it, or choose an available hosted route. |
| Model absent or rejected | Refresh the model catalog; confirm provider access and route support. Do not substitute an unrelated model silently. |
| Insufficient spendable credits | Read available versus reserved credits and outstanding jobs. Reduce the requested work or use the account's supported top-up flow. |
| Hosted service returns 401 | Refresh or reauthorize that service through the app. An OmniSI error does not establish that the OmniRogue account was unlinked. |
| Model/billing setting changed but session behaves as before | Verify the running CLI's model; relaunch for a billing change. |
| A job is still queued or processing | Poll its existing ID. Preserve that ID when reporting a problem. |
| Tool is not listed | Check the service endpoint, account permissions, and deployment version. Do not invent a tool name. |

Report the app version, operating system, endpoint, tool name, sanitized error,
and request/run ID. Include neither bearer tokens nor authorization codes.

Continue with the [MCP reference](UNIFIED-MCP-REFERENCE.md) or
[hosted Evolve guide](HOSTED-EVOLVE-SUPER-INTELLIGENCE.md).

## Source anchors

The versioned contracts are in
[`use-onboarding-flow-types.ts`](../../src/renderer/src/components/onboarding/use-onboarding-flow-types.ts),
[`use-onboarding-omnirogue-account.ts`](../../src/renderer/src/components/onboarding/use-onboarding-omnirogue-account.ts),
[`omnirogue-account.ts`](../../src/shared/omnirogue-account.ts), and
[`omnirogue-gateway-ipc.ts`](../../src/main/ipc/omnirogue-gateway-ipc.ts).
These links describe this checkout, not proof of a particular hosted deployment.
