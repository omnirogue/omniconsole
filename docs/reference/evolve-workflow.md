# Evolve

The **Evolve** preset runs jev-lab's OpenEvolve workflow (`omnirogue/jev-lab`,
`docs/evolve-workflow.md` there) on a fleet host. OmniConsole adds no second population
algorithm, no copy of the evaluator and no model calls of its own: it places the run, drives the
jev-lab CLI on the host over SSH, and keeps a record of what happened. The central ledger
(Postgres on the ER2 server) holds the run, its candidates, evaluations, rubrics and promotions.

## Start

- The Workflow menu's **Evolve** opens a tab with the setup form; `omni workflow run evolve`
  (or `--template evolve`) takes the same fields as flags. Both call `evolve.start`
  (`src/main/runtime/rpc/methods/evolve.ts`) with `EvolveStartRequest`
  (`src/shared/evolve-workflow.ts`).
- Fields: target (`email-smoke`, the synthetic seat smoke, by default; `email`; `ads`; or a spec
  path in the checkout), the jev-lab checkout on the host (default `~/Repos/jev-lab-evolve`, a
  checkout only Evolve workers use), iterations, seed-from, rubric-from, a budget cap (`--usd-cap`,
  never above the spec's group cap), submitted-by, and Run on (the fleet by default, a named host,
  or this computer).
- `submitted-by` defaults to the person: `--requested-by` for an agent caller, otherwise this
  computer's `user@host`.
- Evolve is agent-launchable (`WORKFLOW_AGENT_LAUNCHABLE.evolve`): an agent caller must carry
  `--requested-by "<person>"` and `--request "<their words>"`, which are frozen with the run, and
  can never force a busy host. The CLI sends the agent evidence on `evolve.start`.

## Admission

Everything below is decided before anything is written or submitted; a refusal names the host and
the reason (`src/main/runtime/evolve/evolve-admission.ts`).

1. **Placement** is the workflow placement of `docs/reference/workflow-fleet-placement.md`: the 60 %
   chooser, or a named host up to 0.8 load per core (a person may force it with a reason). A host
   whose runtime has account services is still reached over SSH, because the worker is one process
   there, not a run handed to that runtime; the placement is recorded as `dispatched-seats`.
   `this computer` runs the same scripts in a local `/bin/sh` (refused on Windows).
2. **Readiness**, one SSH call with API key variables unset: Claude signed in with a subscription
   over SSH (the drafter is `claude -p`; `workflowFleetRouteProblem`), then the checkout, its
   `.venv`, and the spec file. For example: `Claude is not signed in on mw0004 (claude auth status
   reports no login over SSH). Evolve drafts with claude -p there, so it cannot run on mw0004.`

## Execution

`src/main/runtime/evolve/evolve-service.ts`, scripts in `evolve-host-commands.ts`:

1. `submit SPEC --submitted-by WHO --json [--iterations] [--seed-from] [--rubric-from] [--usd-cap]`
   freezes the spec in the ledger and answers one JSON line with the ledger run id. A checkout from
   before `--json` is told apart by name.
2. One **detached worker**, `nohup … worker --host <name> --run-id <ledger run>`, its pid and log
   in `~/.omni-fleet/evolve-runs/<evo id>/` on the host (mode 700). It outlives the SSH call and
   this app.
3. **Follow**: every 15 s one SSH call reads the worker's liveness first (`kill -0`), then
   `status <ledger run> --json`. A `done` or `failed` ledger run settles the record. A worker the
   host reports gone while its ledger run is still `queued`/`running` fails the record by name
   (positive evidence from the owning host); the ledger row then needs an operator, as jev-lab's
   guide says. No answer is `unverifiable` and never ends the run; after an hour without contact
   the record reads `unverifiable` and stops following until **Check again** (`evolve.refresh`).
4. **Stop** (`evolve.stop`) sends the worker SIGTERM; jev-lab settles its run as `failed`
   (`KeyboardInterrupt`) and the record reads `stopped`.

The record (`EvolveRunRecord`, `evo_<uuid>`) lives in `userData/evolve-runs/`. After a restart the
first Evolve call (an open Evolve tab's status read, the run view, or `omni workflow status evo_…`)
loads the records and resumes following every `running` one; the worker never waited for it. One
that was still submitting fails by name with what may be left queued in the ledger. Nothing in the record is a credential: the ledger connection strings
stay in the host's `~/.config/omni/connections.env`, read by jev-lab by variable name.

## What the run view shows

The ledger run id and the exact `status --json` command for its host; the ledger status,
mutations evaluated of those requested, candidates, the best so far, spend against the run cap,
the heartbeat's age and the worker's verdict (`live` / `unverifiable` / `exited`); and
**compounding** from the ledger's own records: what `--seed-from` loaded (each earlier candidate,
its source run, its prior score, whether it had been promoted, and its score on this run's data),
the rubrics by digest, and this run's promotion records. An `eligible` promotion never deploys
anything. `omni workflow status evo_…` prints the same record.

The sidebar row takes the run's `LocalWorkflowChangedEvent` (`preset: 'evolve'`), as Council and
Discover rows do; a restart hydrates it with `evolve.show`.

## Hosts

jev-lab's `docs/evolve-hosts.md` has the install per host and each host's state. On 30 Sep 2026
mw0001 had the Evolve checkout, the ledger reachable and Claude signed in over SSH; mw0002 could not
reach the ledger; mw0003 and mw0004 have no Claude login over SSH, so Evolve is refused there by
name.
