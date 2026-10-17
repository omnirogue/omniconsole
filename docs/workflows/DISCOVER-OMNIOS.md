# Discover: fast defaults and results in OmniOS (2026-10-13)

Sal, 13 Oct 2026: "When I launch Discover workflow, its still all default settings fronteir …
haiku 5.5 is fine. but its so much faster. jev would be great too … make it so the results get
brought to me in OMNIOS sheet and i can immediately act on teh results as i do with current
OMNIOS pages … and that i can also launch discover workflows through the mCP with claude/codex
apps."

## Default models

| Step   | Default                                      | Why                                                                 |
| ------ | -------------------------------------------- | ------------------------------------------------------------------- |
| Brief  | each family's default (Claude: Opus 5.5)     | one call that sets the lenses, checks and rubric every step uses    |
| Scout  | Claude Haiku 5.5                             | maps the areas                                                      |
| Find   | Claude Haiku 5.5, one agent per lens (three) | most of the reading; fast and cheap, and Verify checks every result |
| Verify | each family's default, another family first  | a finding counts only when a family that did not write it passes it |
| JEV    | live, discard-only (sets aside at p ≤ 0.1)   | unchanged since 28 Sep (#849)                                       |
| Report | each family's default (Claude: Opus 5.5)     | ranks the results and writes what a person reads                    |

Finders all run on Claude, so Verify (rotated, Codex first) is independent of every one of them:
a confirmed result was passed by another model family. Scout and Find keep the earlier lineup (each
family's default in turn) without Claude, and where no other family can verify (Claude with only
Gemini, which cannot judge), so Claude stays free to check what Gemini finds. Haiku 5.5 needs Claude Code 2.1.293 or later on
the computer that runs it. The Models card and `--models` change any of this per run, as before
(`MODEL-TIERS.md`).

`DISCOVER_FAST_MODEL` in `src/shared/workflow-graph-templates.ts`. Runs admitted before this keep
their frozen lineup; `workflow-discover-screen.test-fixture.ts` keeps that era's text for replay.

Measured on 10–11 Oct (Intelligence-10x, 40 real tasks): Opus 5.5 high 1.76 of 2, Haiku 5.5 high
1.55, medium 1.49; Astra high 1.80. Haiku is weaker alone, which is why it finds and frontier
models of another family verify and report.

## Results in OmniOS

Completed Discover and Quick Discover runs enter `discover_omnios_outbox`, keyed by run id in
this runtime's orchestration database. App startup and a two-minute reconciliation sweep inspect
completed runs, including ones started by the CLI or completed before restart. They project
journaled results without resuming model calls. Isolated runs and the off switch remain excluded.

Delivery writes `page.html`, `findings.json`, `report.md`, `publish.sh`, `start.sh`, `dig.sh`, `decide.sh`,
`actions.sh` and `close.sh` to `<userData>/discover-omnios/<run>/`, then starts one Claude Sonnet session
(medium effort) in the run's workspace with the brief from `src/shared/discover-omnios-brief.ts`. A definite
prelaunch account-readiness refusal can use a verified Codex account instead; the selected provider is
persisted before launch. Unknown launches never switch providers.

The session runs `publish.sh share "<reviewers>"` (its standing instructions name the reviewers,
plus whoever asked for the run, as emails or emp_ ids; `--audience team`, no category: a category
decides who may answer and a guessed one is worse than none), so the page is published from its
own terminal: it waits live,
then sleeps, and the answer wakes it, as for any page a session asks about. On the answer it starts
what the person picked, finding by finding:

- **Start**: `start.sh <n> contract-<n>.json` runs `omni session launch --provider claude
--contract …` in a separate worktree at the run's recorded commit on its execution host.
  Admission records the commit, branch, origin and dirty status in `host.discoverSource`, copied
  into `findings.json`. With an origin, Start fetches its current branches and refuses unless
  that commit is reachable there. Without an origin it still creates a private local worktree
  per finding. Dirty source, an unregistered/plain folder, a context-only run or an older run
  without a recorded source blocks Start with a reason; it never shares the person's checkout.
  The contract's verify seat checks the work.
- **Dig deeper**: `dig.sh <n> dig-<n>.md words-<n>.txt "<who>"` runs `omni workflow run --template
discover --depth quick --focus-finding <run>:<n> … --requested-by=… --request=…`.
  The host resolves n in the completed parent's ranked page, checks it is the same workspace,
  seeds the brief with that finding's evidence and next step, and removes its title from the
  earlier-runs list. Other titles stay listed and delivery stays enabled. Quick depth is one
  find-and-verify round; the focused run comes back as its own page. Older hosts reject the
  new request/draft field by name instead of silently ignoring focus.
- **Not now**: `decide.sh <n> not-now` records it.

The scripts carry each finding's title quoted by the app and read the person's words from a file,
so no title or note is ever typed into a command line, and each starts a finding once
(`started-<n>.json`, `dug-<n>.json`).

Only a successful terminal launch receipt becomes `started-<n>.json`. `close.sh <note> <page> <every
selected Start number>` checks those receipts before closing as done. A refused or uncertain
Start stays blocked with its reason and leaves the page open. The scripts require Node.js to
read CLI JSON receipts. It never moves money, sends to customers, changes ads
or budgets, deploys or grants access.

Every pick lands in `decisions.json` in the run's folder, one row per finding: its target key, the
pick (`start`, `dig` or `not-now`) and, once one exists, the launch or run receipt. `start.sh` and
`dig.sh` record their own picks through `decide.sh`. The next run on the same target reads it: a
finding picked Start or Dig deeper is listed to its finders first, whatever its verdict (see
`workflow-earlier-findings.ts`). `omni workflow stats` sums the picks on this computer's pages
into an acted-on rate.

The page (`src/shared/discover-omnios-page.ts` for what it holds, `discover-omnios-page-html.ts` for
the HTML) keeps every eligible finding and asks about eight at a time, the number a Decisions
card shows as its own controls. Later pages keep the evidence and controls with stable finding
numbers. Confirmed findings come first; within each group the report's ranking comes first, then
unranked findings by impact. A missing, partial or malformed ranking never preselects Start. With
a complete ranking, only the first three reviewer-confirmed findings default to Start. The
headline distinguishes confirmed findings from those needing review and states how many are shown.

Results the reviewers refuted, JEV set aside, or citing no existing file are counted separately.
Each finding shows its status, votes, repeats, JEV probability, independence, effort and risk;
missing estimates say unknown. New Discover specs set `rankEstimates: true`; saved older specs
keep their original ranking prompt and request digests. Failed calls and coverage gaps stay above the findings.

`omni workflow render-page findings.json` rebuilds `page.html`, `page-2.html`, etc. before every
publish; requested edits change fields in JSON, never HTML or edit keys. `publish.sh share|update
"<reviewers>" [page]` publishes each page separately, retaining its own receipt. The session
waits for each page's own answer before acting or presenting the next page.

The page reports both named edit fields and structured `{n,key,pick}` selections. Native
multi-pick answers retain their `selected` indices and titles as JSON in the wake message.
`actions.sh <page>` reads the complete saved answer through `omni artifacts status`, then
`omni workflow page-picks findings.json --answer status.json --page <n>` checks the current
approved revision and validates every pick. Each Start or Dig deeper goes through its existing
per-finding script; a refusal does not prevent later picks from being processed. Unticked
native options become Not now, not implicit Starts. No first-page approval applies to later pages.
The full report stays folded at the end, and the page has no button of its own.

The outbox stores the launch operation id, stage, attempts and next retry time; `launch.json`
mirrors that identity for inspection. A refused start retries after 2 and 10 minutes; subsequent
sweeps recover pending work after restart. An interrupted preparation can retry; a launch that
may have started stays protected from duplicate creation. Existing `launch.json` files are imported.

**Delivered means published:** a successful `published.json` receipt must name an HTTPS page URL.
A launched publishing session without that receipt remains `pending`, never delivered. A pending
or unknown session is retained for reconciliation and is not replaced by another publisher.
`omni workflow status <run> --json` reports its state and the URL once published.
`omni discover deliver <run> --json` attempts delivery of one completed run without running Discover
again. If its publisher is still pending or unknown, it reports that state for inspection.
The new strict RPC method `localWorkflow.discoverDeliver` fails on older runtimes rather than
silently rerunning anything. Failed, stopped and isolated runs remain excluded; the app's
`OMNI_DISCOVER_OMNIOS=0` disables automatic and manual delivery.

When Verify settled but Report failed or returned no result, Discover completes with a deterministic
report of its targets, ordered by impact then severity. A gap names the failed Report. Brief and
Scout failures on newly admitted runs (seat rules 2) can move once to a verified-capacity seat of
another known model family. A second failure stops the run; fatal cancellation and old replay rules
are unchanged.

### The two CLI runs observed on 14 October

Read-only inspection on 15 October found both `e3939a5f-ebee-46c5-a531-bc118f0c5ac0` and
`d1048227-ccf9-48fa-ad4b-c82ac4942993` completed, non-isolated, with template `discover`, local
placement and no delivery files. The installed 1.12.37 bundle contains the settlement hook and
delivery code. Its archive timestamp is 14 October 20:30:28 ET; the current app process started
at 20:47:14 ET, after both completed (19:35:37 and 20:44:58 ET). Historical logs do not establish
which build or environment held their live settlement callbacks, so an older build alone is **not
proven**. Source confirms that `--no-follow` merely stops CLI polling, and CLI origin does not
exclude delivery. The reproducible defect is that a completed run missed by its live observer has
no startup recovery. The outbox sweep covers that case for both CLI and app origins.

## Where it runs

Left on the fleet (the default), a Discover the fleet cannot take (Grok seats, a fleet Claude
signed out, no spare capacity) runs on the computer it was started from, with the reason on the
run (Sal, 14 Oct 2026; `docs/reference/workflow-fleet-placement.md`). Dig deeper runs started by
the delivering session follow the same rule.

## From a connected AI

The runtime advertises `workflow.discover-omnios.v1` and `workflow.discover-omnios.v2` when it
delivers. v2 accepts `--requested-by-id <emp_id>` alongside `--requested-by <person>` and
`--request <their words>`; the id must match `^emp_[a-z0-9_]{1,64}$`. The executor sends it only
where v2 is advertised. The id is frozen with the run: when there are findings, `publish.sh`
always adds it to the reviewers on share and update, without repeating it. Standing instructions
still name the other reviewers; without an id the session looks the requester up as before.
Dig deeper carries the id into the next run. A page with no findings stays a plain page.
Start still belongs to the person who answered.

OmniOS's `launch_discover`
(AI operators) asks the execution computer's AI-operations adapter to run
`omni workflow run --template discover --runs-on local --no-follow …` there, and refuses where the
capability is missing; `get_discover` reads the run's state. See omni-console
`knowledge/docs/omnios/routines.md`.
