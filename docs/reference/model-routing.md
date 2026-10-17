# Experimental model routing

The router chooses an available model and effort for each new piece of work. Its
priority is time to a useful, acceptable result. It keeps the existing complexity
classifier, Reverse Prompting, JEV gate, account checks and dispatch ownership.

## What was disconnected

The preparation flow already called `~/Work/Ops/autonomy/bin/omni_route.py`, but a
computer without that file silently kept the previous model. The verified native
session launcher and ordinary outcome actors also used host defaults when no model
was supplied. Classifier logs therefore did not prove that normal work used its
choices, much less that the work completed successfully.

The application now includes the existing classifier and its JEV adapter. An
explicit `OMNI_ROUTE_SCRIPT` still wins, followed by the existing estate script,
then the bundled copy. `resources/dispatch-router/manifest.json` records provenance
and hashes. The bundled copy removes prompt previews from its decision log; it does
not change the classifier's questions, JEV thresholds or escalation rules.

## Starting work

- **+ → Need Speed?** accepts one objective or up to twenty separate rows. Each row
  is submitted independently. Reverse Prompting may split an individual objective;
  it does not merge the rows into one project. Simple, complete requests can use the
  existing direct preparation path.
- **Conversation** can dispatch a fresh, self-contained objective automatically.
  Follow-ups stay with their current owner. This intake is supported in native chat
  and the existing Claude human-submit hook (goal-framed first requests only). Other agents can use the verified
  `omni session launch` or outcome APIs; their arbitrary conversation text is not
  intercepted. Explicit dispatch syntax remains supported.
- **Verified session launch** routes omitted models within the requested provider.
  A provider supplied by a caller is a constraint. Opening an empty agent terminal,
  resuming work, explicit model/account/template/argument choices and prepared
  launches keep their existing behavior.
- **Outcome actors** route omitted models while preserving explicit choices and
  the existing canonical cross-model review assignments. Automatic outcome choices
  currently require Claude/Codex account evidence and the workflow adapter's
  supported models. Other workflow providers retain their previous defaults with
  an unavailable routing receipt until that evidence is supported.

Need Speed preserves local and SSH workspace selection. Paired-runtime workspaces
currently show an unavailable message rather than executing on the wrong computer.
The runtime capability `session-prep.routing.v1` is required for the new interface.

Accepted rows use durable request IDs: retrying an uncertain submission reuses the
same request, and changing its payload is refused. Drafts and their request identities are stored per profile/workspace and survive
renderer restart. An interrupted submission becomes retryable with the same identity.
Accepted request deduplication lasts for the existing batch retention period.

## How a choice is made

1. Preserve the user's explicit model, provider, effort and execution method.
2. Apply the existing rules, semantic shortcut and JEV complexity path. Difficult
   or risky work retains the stronger tier; this change does not loosen quality gates.
3. Obtain the execution owner's existing account-aware model discovery results.
   Static menu entries do not establish availability. Probe work is shared and
   bounded to two concurrent probes with a three-second foreground wait.
4. Match the tier to discovered, launch-compatible models and supported effort
   levels. The catalog recognizes Astra, Sol 6.1, Terra, Luna, Opus, Fable, Sonnet,
   Gemini 3.8 Flash, Kimi and Grok; it never invents an ID or enables an account.
5. Verify the actual selected launch account before using an automatic model.
   Native sessions probe that account; workflow choices are intersected with the
   existing workflow adapter and every eligible account it may select. Continue
   through the existing account and host launch checks. A route is a recommendation,
   not authorization or evidence of completed work.

Fast-tier candidate preference starts with Luna, then exact Gemini 3.8 Flash and
Sonnet. Standard-tier preference starts with Sol 6.1 and Terra, with Opus preferred within Claude. Frontier preference
uses Opus and Astra. These are initial policy preferences, **not measured latency
or dollar-cost predictions**. A family can be absent on a particular host. In
particular, a provider advertising a different Gemini model is not proof of 3.8.
Fable remains explicitly available; automatic routing preserves the existing policy
of reserving its usage credits. Explicit effort is never silently reduced. Missing
or incompatible automatic candidates retain the previous launch choice with an
unavailable receipt. If a prepared automatic choice fails the final account-specific check,
preparation records an unavailable reason before creating a worker; choose a
verified model explicitly or retry with routing Off. Explicit model choices bypass
classification and remain the launch adapter's responsibility. A disabled explicitly requested provider is refused
rather than silently replaced, including when routing is off.

The preparation view, native launch receipt and outcome step record show routing
status, reason, tier, classifier duration/version and selected model when available.
`selected` means the router's choice. It does not attest which backend model a
provider ultimately served. Launch receipts similarly do not prove task completion.

## Parallel work and resource use

All preparation batches now share the existing four preparation slots. Submitting
several objectives cannot multiply that preparation limit. The existing terminal
start pacing and outcome-chain concurrency limits remain in effect. Independent
objectives can proceed independently; dependencies within an objective still use
the established planner and outcome machinery.

Host placement keeps its existing CPU bands and adds measured free memory as a
ranking input within a band. Unknown memory is unknown, not fabricated capacity.
This is not a new global limit on all live agent sessions. It does not close human
sessions or alter the estate's concurrency limits.

## Reversibility

In Need Speed, **Routing mode** controls new work on the executing computer:

- **On** chooses models automatically.
- **Observe** records suggestions while keeping existing model choices.
- **Off** stops applying router choices across preparation, native launch and
  outcome actors, and disables automatic conversational intake.

A host set to Off or Observe overrides a request's previously saved live mode.
Changing the mode does not cancel or modify work already running. The separate
**Route new objectives from conversation** checkbox controls whether fresh
conversation objectives are dispatched. `agent:` keeps a message in its current
conversation. Explicit dispatch requests remain available.

Operators can override the host setting with `OMNI_DISPATCH_ROUTER_MODE=off`,
`shadow` or `live`. The environment override wins over a request. An off switch is
not permission to change an explicit model/provider choice. Keep the previous
signed application and profile backup when installing a candidate; follow the
supported installer rather than replacing serving files in place.

## Validation limits

Tests cover independent rows, durable retries, model and effort constraints,
execution-host discovery, disabled providers, off/shadow behavior, launch replay,
resource ranking and shared preparation slots. A rendered Electron test exercises
the menu, multiple prompts, draft preservation and partial-failure retry.

A controlled synthetic comparison on 7 October 2026 used six identical objectives
covering easy, medium, difficult, coding, evidence-based selection and independent
answers. Both Luna/medium and Astra/high passed 6/6. Dispatch-to-completion was
11.043 seconds and 22.066 seconds respectively. This is one trial per model with
different session context/cache state, not a general benchmark, proof of physical
parallel execution or a claim of production-wide quality equivalence. Served model
identity and monetary cost were not independently attested. Real rollout receipts
and completed outputs must be inspected separately before claiming activation.
