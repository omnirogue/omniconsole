# Workflow core (2026-09-22): one model, one interpreter, four step kinds

Sal's brief: make the workflow system in Omni-IDE (`main-next`) small, reliable and flexible.
Audit first, then settle on the fewest primitives that express Council, Discover, Build + Review and
custom workflows. Natural language should compile into a valid graph that can be seen, edited and run.
Build on the Orca orchestration backbone and leave ordinary development and orchestration alone.

This document is the contract the implementation follows. Paths are relative to the repo root.

## 1. What is wrong now, and why (audit of `origin/main-next` 4fa57fd12)

**Five execution systems do one job.**

| System | Where | Used by | Notes |
|---|---|---|---|
| Headless program runtime | `workflow-execution-service.ts`, `workflow-durable-call.ts` | Council 6, Discover 7 | Journaled, retried and fenced. Never run by Sal: the installed app has 0 runs of it. |
| Working-agent runtime | `working-workflow-execution-service.ts`, `workflow-working-*.ts` | Council 5, Discover 6 | Orca Task/Dispatch in child worktrees. It is behind all 4 recorded runs, 2 of which are stuck in `running` forever. |
| Build + Review pipeline | `build-review/*` (~3.5k lines) | Build + Review | Orca Run/Task/Dispatch. Reviewers run one at a time. There is no deadline on the work itself. |
| Local Runs DAG runner | `build-review/local-run-*` (~2.4k lines) | "Run a graph…" | Orca Tasks with deps, a mailbox pump and a graph editor. |
| Script runtime | `workflow-script-runtime.ts` | dry-run only | A clone of UltraCode's `agent/parallel/pipeline`. Nothing executes it. |

**The evidence (observed, not inferred).**
- Every recorded Council/Discover run on this Mac (the `omni-dev` DB) used the working-agent path.
  - `814b2645`: Claude's Dispatch failed with `agent_prompt_stalled`, but its workflow call stayed `running`. The failure never propagated, so the run hangs forever.
  - `9d0f50f4`: all 3 answer calls are still `starting` with no Dispatch since 21:00. No timeout exists for that state.
  - `069f055e`: completed, but each ballot ranked only 2 labels. That is pairwise voting, not Karpathy's ranking, so scores can only be 0, 0.5 or 1.
- Quality diagnostics: Council scored ≤ a single Claude Sonnet answer (48–49/60 vs 51–57). One Grok timeout zeroed a whole case because a missing member failed the run. Discover 5/6 found 4/4 seeded bugs, as did Sonnet alone, at ~3× the cost.
- **Council's revision-6 "street cred" is miscomputed** (`council-ranking.ts:153`). A voter's own answer is dropped, but positions are not renumbered. A voter that ranks itself first therefore pushes every other answer down one place.
- Discover 7 spends ~2,000 lines on budget arithmetic. Examples: per-round vote reservations, "a serialized finder keeps one job a round", "votes other jobs did not need". Over 20 commits in 24 hours tuned it. None of that is measured to improve results.
- Build + Review:
  - Its wait loop has no deadline, so a prompt stuck in a terminal hangs the run.
  - Reviewers run sequentially.
  - Retry restarts at round 1 on a tree that already has the changes.
  - A builder that reports failure can still end `completed`.
  - Reviewers are read-only by prompt only.
- **The UI has no picture of the flow.** Council and Discover are bespoke screens (~12k lines under `local-workflows/`), and stages are a vertical list with no edges. The only graph canvas (`local-run/LocalRunCanvas`) is not used by workflows. Nothing shows "these 4 ran in parallel and fed those 2".
- **Every preset is special-cased**: its own draft fields, lineup rules, admission, call-limit arithmetic, projection, setup screen and run view. A new workflow means writing all of those again.
- **Revisions pile up.** Council 1–6 and Discover 1–7 are all kept "byte-identical for replay". So is working-agent routing inside core orchestration settlement (`worker-report-settlement.ts` hard-codes `answers/` and `synthesis/final`).

**Why the workflows aren't useful yet:** the path Sal actually used can hang silently. The quality-bearing parts (aggregation, degradation) have correctness bugs. The effort went into accounting rather than into the few things that make multi-agent work better than one agent:
- **diverse families**
- **blind comparison**
- **evidence-backed verification**
- **one strong synthesis**
- **honest degradation**

## 2. What is preserved

- **The durable call engine.** `WorkflowExecutionService`, `createDurableWorkflowAgent` and `WorkflowCheckpointStore`:
  - input-digest call identity
  - journal replay (no duplicate work)
  - attempts with the rejection named on retry
  - fences
  - owner recovery
  - process-tree kill on stop
  - atomic result commit
- **Provider launch.** `local-workflow-provider-*`: headless Claude/Codex/Grok/Gemini with read-only tools, account routing, native result parsing and attestation.
- **Live view plumbing.** `LocalWorkflowLiveRegistry`, the `localWorkflow.watch` stream, `readCall` and tab/sidebar status.
- **The program port**: `agent / parallel / phase / log` (`workflow-program-context.ts`). This is UltraCode's model, and the interpreter below is one program on it.
- **Karpathy's prompts and parser.** `council-v6-prompts.ts` and `parseCouncilRanking`.
- **Discover's verification ideas.** Three-lens refute-first votes, and "missing is unjudged, never refuted". The dedup key comes from `discover-v7-dedup.ts`.
- **Build + Review's executor** on Orca Run/Task/Dispatch, with its terminals, questions, startup prompts and workspace lock (1.4k lines of hard-won edge cases). It stays the executor for the one editing workflow.
- **UI building blocks**: `WorkflowCallBody`, live tail, `CommentMarkdown` documents, `AgentIcon`, `WorkflowSeatChips`, `WorkflowRunHeader`, the layered layout in `lib/console-workflow-layout.ts`, the ＋ menu and the tab anchor.
- **Old runs still open.** Legacy revisions stay replay-only: no new run is admitted on them, and their code is untouched in this change.

## 3. The model: four step kinds, two modifiers

A workflow is a small directed acyclic graph of **steps**. Parallel and sequential are not node types; they are what the graph looks like:
- **Parallel:** a step with N agents, or two steps that don't depend on each other.
- **Sequential:** an edge.

```ts
type WorkflowSpec = {
  version: 1
  title: string
  steps: WorkflowStep[]
  repeat?: { do: string; review: string; until: 'approved' | 'nothing-new'; maxRounds: number }
}
type WorkflowStep = {
  id: string                       // slug, unique
  kind: 'do' | 'review' | 'rank' | 'synthesize'
  title: string                    // "Research", "Critics", "Final answer"
  instruction?: string             // what the agents are asked; the kind supplies a default
  agents: { route: 'claude' | 'codex' | 'grok' | 'gemini'; model?: string; angle?: string }[]
  inputs: string[]                 // upstream step ids
  forEach?: { step: string; limit: number } // an input that lists items: one run per item (limit 1–24)
  list?: { maxItems: number }      // do only: produce items (for a downstream forEach) instead of text
}
```

| Kind | What its agents do | Output the runtime parses | How outputs combine |
|---|---|---|---|
| **Do** | Answer, research, draft or find. Reads the question and its inputs. | Markdown, or a list of items `{title, detail, location?, severity?}` | Each agent's output is kept, labelled by model |
| **Review** | Critique the inputs (or one item). Ends with `VERDICT: PASS / FAIL / UNSURE`. | Critique plus verdict | Per target, a majority tally. A missing vote counts as UNSURE, never FAIL |
| **Rank** | Compare ≥2 anonymous candidates. Ends with `FINAL RANKING:`. | A full ballot | Average rank. A voter's own candidate is removed *and the rest renumbered* |
| **Synthesize** | One agent writes the single answer from everything upstream, with names shown, plus standings and verdicts. | Markdown | It is the result |

**Modifiers:**
- **For each**: fan a step out over the items another step listed. For example, one finder per area, or three votes per finding.
- **Repeat until**: loop a Do → Review pair until reviewers approve, or until a round finds nothing new, for at most N rounds (1–5). In rounds ≥2 the Do step receives the reviews ("address this"), or the items already known ("skip these").

**What was dropped, and why:**
- **Agent** is what fills a step, not a node.
- **Parallel / Sequence** are graph structure.
- **Judge** splits into Rank (relative) and Review (absolute).
- **Verify** is Review with *for each* and a majority tally, or Review gating a repeat.
- **Condition/Route** is left out. A model-chosen branch makes the run diverge from the picture. The two conditionals that matter are built in and always visible: *repeat until* and *nothing to do* (an empty list).
- **Human** is left out of v1. The natural extension is a person as a Review seat ("you approve"), which needs no new kind.

**Run-level settings** (progressive disclosure, all defaulted):
- **Access:** agents read the workspace read-only (default), or knowledge only.
- **Team:** the model and effort used for each family.
- **Concurrency.**

**Defaults the runtime applies so users configure almost nothing:**
- Agents rotate across available families; mixed families beat N copies of one model.
- Reviewers and rankers are picked from families other than the work's authors where possible.
- The synthesizer is Claude.
- Gemini may only Do (estate rule: it never issues verdicts).
- Rank inputs are anonymised with rotated presentation order. Synthesize sees real names.
- Timeouts: Do 20 min, Review 10, Rank 10, Synthesize 15.

**Validation** (`validateWorkflowSpec`, shared by editor, compiler and host). Invalid graphs cannot start.
- **Structure:**
  - 1–12 steps with unique ids; inputs exist; no self-input; acyclic.
  - Exactly one final step (nothing consumes it). Every other step must feed something: "Critique's output isn't used".
- **Agents:** 1–8 per step, and Synthesize has exactly 1. Gemini is only allowed in Do.
- **Review:** reviews Do or Synthesize output, never a review or a ranking.
- **Rank:**
  - Needs ≥2 candidates from Do/Synthesize inputs, and at most 8.
  - No *for each*.
- **Synthesize:** needs ≥2 upstream results to combine.
- **For each:**
  - The source must be an input that produces a list.
  - A *for each* over another *for each* list is flattened.
  - Items are deduplicated in code before fan-out.
  - Caps are logged and shown, never silent.
- **Repeat:**
  - The Review must consume the Do.
  - `until: 'approved'` needs a Review without *for each*.
  - `nothing-new` needs a list-producing Do and a *for each* Review over it.
  - Only one repeat per workflow.
- **Size:** at most 200 planned agent calls, computed as an exact upper bound and shown before Start.
- **Warnings** (shown, not blocking): reviewers from the same family as the work; one ranker ranking its own answer; a final step with several agents and no synthesis.

## 4. The three workflows on this model

**Council** (Karpathy). `answer` feeds `rank`, and both feed `chair`.
- `answer`: Do × members (Claude, GPT, Grok, Gemini).
- `rank`: Rank × members that may judge. Inputs: answer.
- `chair`: Synthesize × 1. Inputs: answer and rank.

Karpathy's stage-2 and chairman prompts are kept verbatim. The self-vote is removed from the aggregate with renumbering. One failed member degrades the run instead of failing it.

**Discover.** Four steps, `scout` → `find` → `verify` → `report`, with `repeat{find, verify, until: nothing-new, max: depth}`.
- `scout`: Do × 1, lists areas.
- `find`: Do × lenses (correctness / reliability / security, rotated across families), *for each* area, lists findings.
- `verify`: Review × 3 lenses (mechanism / reachability / reproduction), *for each* finding. Refute-first; majority decides.
- `report`: Synthesize × 1, which ranks confirmed findings by blast radius.

The v7 budget planner is replaced by caps that are shown on screen. A finding is Confirmed with ≥2 PASS, Refuted with ≥2 FAIL, and Unverified otherwise.

**No JEV screen in the default Discover (2026-09-27).** The template's `verify` no longer carries
`forEach.screen` (the brief's 0–4 rubric screen that set findings aside before review); it keeps
`order: 'impact'`, `merge: 'root-cause'`, the limit of 40 and escalation. Every finding goes to the
impact triage and the reviewers. The screen itself stays: a saved spec or a `--spec-file` overlay
can still put `"screen": {"rubricFrom": "brief"}` on the step, and then Discover's set-aside gate
(`discover-set-aside@1`) and the web-page rubric rule apply as before. Without it the default
Discover makes no screen decision (its only JEV decision is live verify, on since 2026-09-27; see
§17.1), and a run that reads pages needs no written rubric. Evidence: on the frozen seeded storefront
(`config/scripts/workflows/benchmark/discover-seeded`, 12 bugs, answer key v2), real
`omni workflow run --template discover` runs on build 1.12.18-28662acf2655, one at a time, three per
arm, shadow `jevVerify` on in both: screen off, recall 0.92/0.42/0.92 (mean 0.75), precision
0.26–0.38, 58–84 min, 121–140 calls; screen on, recall 0.92/0.33/0.58 (mean 0.61), precision
0.26–0.33, 43–80 min, 127–149 calls. The screen gave no quality benefit and saved no calls; three
earlier runs showed the same, with the screen score's AUC ranging 0.47–0.87 across runs.

**Build + Review.**
- `build`: Do × 1, which edits the workspace.
- `review`: Review × N, reading the workspace. `repeat{build, review, until: approved, max: rounds}`.

The one step kind that edits files runs on the existing Orca Build + Review executor (Run/Task/Dispatch, live terminals, questions). The spec is compiled to its start request, and its snapshot is projected onto the same graph view. Reliability fixes land in that executor:
- a work deadline, so no infinite wait
- reviewers in parallel
- a failed builder never ends `completed`

A custom graph may use a write step only in this shape in v1. Everything else is read-only analysis on the headless engine.

**Sal's example**, "4 agents research, 2 critics, one synthesizer":
- `research`: Do × 4.
- `critics`: Review × 2. Inputs: research.
- `final`: Synthesize × 1. Inputs: research and critics.

## 5. Natural language → validated workflow

1. **＋ → Workflows → "Describe a workflow"** opens a chat-style screen. The presets (Council, Discover, Build + Review) sit beside it as one-click templates.
2. **Compile.** One headless Claude call, with no tools and a native JSON schema. It gets:
   - the spec schema
   - the four kinds with their rules
   - three worked examples
   - the user's text
   - on follow-ups, the current spec ("make the critics GPT and Grok" edits; it does not regenerate)

   It returns `{ spec, assumptions[] }`.
3. **Normalize.** Deterministic code fills in the defaults. It clamps counts, slugs ids and assigns families by rotation, so the model only has to get the structure right.
4. **Validate** with the same `validateWorkflowSpec` the host uses. On errors, one automatic repair turn sends the errors back. Anything still invalid opens in the editor with the problems pinned to the steps. It is never runnable while invalid.
5. **Show:**
   - the graph
   - a plain-English readback ("4 agents research in parallel → 2 critics review all 4 → 1 synthesizer writes the final answer · up to 7 agent calls")
   - the assumptions

   Then comes a single **Run** button.

## 6. Visual builder and run view (one screen, two states)

- **Graph.** Columns are dependency levels, left to right: everything in a column can run at once.
  - Each step is a card: kind icon, title, agent chips (model icons, ×N), plus badges for *for each* and *reads workspace*.
  - Edges are drawn. *Repeat* is a dashed return arrow labelled "until approved · max 3".
- **Edit** (before Start):
  - Clicking a step opens an inspector with title, instruction, agents (add/remove/model), inputs (checkboxes that offer only earlier steps, so a cycle cannot be built), *for each* and list.
  - "Add step" appends a step of a chosen kind wired to the selected step.
  - Validation shows inline on cards, plus a bar: "Ready · up to 7 agent calls", or "2 problems".
- **Run** (same cards, live):
  - Each step shows its state: waiting · running (n/N) · done · done with gaps · failed · not run (why) · nothing to do. Agent chips pulse while running.
  - Selecting a step shows each agent's live tail, then its output, and for *for each* the items with verdict dots.
  - Rank shows the standings table. The final step's output is the highlighted result document.
- **Presets.** Council, Discover and Build + Review open with a question box, a team picker and a **Customize** link to the full editor.
- **Legacy runs** keep rendering in their existing views.

## 7. Runtime invariants

1. **Frozen plan.** The validated spec and the resolved seats are frozen into the execution snapshot at Start. The view draws that snapshot, never the editor's draft.
2. **Deterministic identity.** Each agent call id is `step[/r<round>][/i<item>]/a<agent>`, with the input digest over prompt + seat + schema. The journal replays accepted results, so resume and retry never re-run accepted work.
3. **Dependencies.** A step starts once every input step has settled. Independent steps run concurrently. A *for each* step starts when its source has settled, because dedup needs the whole list.
4. **Attempts.** Each call gets up to 2 attempts in a run. A rejected answer (schema, missing verdict, partial ballot) is retried with the problem named. Every call has a hard timeout, and the process tree is killed when it expires.
5. **Step outcome.**
   - done: every agent succeeded.
   - done with gaps: at least one agent succeeded; the failures are listed.
   - failed: no agent succeeded.
   - *For each* is the same, per item.
6. **Run outcome.**
   - completed: the final step succeeded and nothing had gaps.
   - completed with gaps: the final step succeeded; the gaps are listed above the result.
   - failed: a step failed; the steps downstream of it are marked "not run: <step> failed".
   - cancelled.

   No run is "completed" without a final output.
7. **Nothing is silently skipped.** Every step ends in a visible terminal state. Empty lists show as "nothing to do". Caps and truncations are logged on the step.
8. **Nothing hangs.** Every call has a timeout, and the run has a ceiling. On the Orca path, a failed or stalled Dispatch fails its call and a missing report is settled from disk; waiting on a person is shown as *needs you*, not as running.
9. **Outputs are durable before use.** Downstream prompts are built only from accepted, stored outputs. Input truncation is explicit in the prompt and in the log.
10. **Cancel.** Stop aborts running calls, and queued calls never launch. Accepted results are kept, so Resume and Retry reuse them.
11. **The view is a projection.** Step states come from durable call rows plus the live overlay. The renderer never infers progress.

## 8. Implementation and verification plan

**Code** (all under `src/`):
1. `shared/workflow-graph.ts`: spec types, defaults, `normalizeWorkflowSpec`, `validateWorkflowSpec` and `planWorkflowCalls` (the exact upper bound).
2. `shared/workflow-graph-templates.ts`: Council, Discover, Build + Review and "research → critics → synthesis".
3. `main/runtime/workflow-script/presets/workflow-graph-program.ts`: the interpreter on `WorkflowProgramContext`, with prompts, parsers (verdict, ballot, list), tally, standings with renumbering, repeat, and outcome semantics.
4. Host: admit `preset: 'graph'` drafts carrying a spec. Resolve families → seats from the host catalog, freeze the spec, pin `graphProgramRevision: 1`, and dispatch in `workflow-preset-runner.ts`. New Council/Discover starts compile to their templates. Legacy revisions stay replay-only.
5. Projection: `graphRun` on `LocalWorkflowView` (steps with state, agents, items, standings, verdicts, edges, repeat round), derived from call ids.
6. Compiler: `localWorkflow.compile` RPC, a one-shot headless Claude call with a JSON schema, then normalize, validate and repair once.
7. Renderer: the ＋ → Workflows chat compile screen, `WorkflowGraphView` (design and run), step inspector, and preset setups on the same view.
8. Build + Review executor fixes: a work deadline, parallel reviewers, and no `completed` after a builder failure.

**Proof:**
- **Unit tests:**
  - every validation rule, with a valid and an invalid case each
  - normalization defaults
  - parsers
  - standings renumbering (a regression test for the self-vote bug)
  - the interpreter on a scripted fake agent: parallel fan-out, *for each*, dedup, both repeat modes, gaps, failure propagation, not-run marking, cancel, and replay with zero new launches
- **Host integration** with the fixture provider (a real Node child process, no paid inference):
  - kill mid-run then recover without duplicate launches
  - timeout, then retry
- **Live, on the dev app, with real CLIs:**
  - Council on a real question
  - Discover on this repo's `src/shared` focus
  - Sal's example compiled from the sentence above
  - Build + Review on a small change

  Each needs screenshots of setup, running and result, and the final states recorded from the DB.
- `tc:node`, `tc:web`, oxlint on changed files, max-lines ratchet, localization checks, then GitHub `verify`.
- Cross-model review (codex-critic) of the runtime and validator before merge.

## 9. As built (2026-09-22, branch `feat/workflow-core-0922`)

**Where it lives.**
- Model: `src/shared/workflow-graph.ts` (types), `-normalize.ts`, `-topology.ts` (order, levels, call bound, readback), `-validate.ts`, `-templates.ts`, `-edit.ts` (editor operations), `-compile.ts` (natural language).
- Interpreter: `src/main/runtime/workflow-script/graph/`. `graph-plan.ts` is the pure planner, split into scope, step, step-calls, step-derive, loop and outcome. `graph-program.ts` is the event loop on the durable port. `graph-supersede.ts` and `graph-checkpoint.ts` hold the replay rules.
- Host: `local-workflow-graph-admission.ts`, `local-workflow-graph-projection.ts`, and a graph branch in the preset runner, projection, call projection, checkpoint admission, finish and retry eligibility.
- UI: `src/renderer/src/components/workflow-graph/`. Canvas, step editor, repeat control, describe panel, setup, run view and step detail.

**Semantics settled while building:**
- **Failures that block, and failures that don't.**
  - A failed **Do or Synthesize** step blocks every step that reads it ("Not run: X failed").
  - A failed **Review or Rank** step is advisory: the Do or Synthesize step reading it goes on without it, and the run completes with that gap named. This mirrors Council 6, where the chairman decides from the answers alone when every ranking fails.
- **Rank with fewer than two answers** is "Nothing to do", shown with its reason; the synthesizer proceeds.
- **Supersede rule.** A failed call becomes final once a *downstream* step has recorded a call. Inside a repeat it depends on the mode:
  - **Until approved:** a later round, or this round's Review for a Do call.
  - **Until nothing new:** only a Do call is superseded, by a later round or by its own round's Review. Reviews never gate the next round, so a failed review stays retryable.
  This keeps replay digests stable and lets Retry re-run only the failed frontier.
- **Approval** needs every *configured* reviewer to pass (unanimous). A reviewer who did not answer withholds approval. A finding's verification votes still use a majority: they classify a claim, they do not approve work.
- **A step that defines PASS itself** (Discover's verify: PASS = the defect is real) gets a neutral verdict line that defers to its own instruction, never the generic "correct and complete" meaning.
- **Verdicts and ballots are strict.** Only the last `VERDICT:` line counts, read as a whole known phrase. A ballot is read from its last `FINAL RANKING` heading and must number every candidate exactly once. Anything else is "no verdict" or "no ballot", never a guess.
- **A run never completes on an empty result.** A blank or empty final step fails the run and says so.
- **A merge never hides a claim.** Duplicate reports are merged to save work. A merged report is folded only when it is a byte-for-byte copy of one already held: same title, detail, location and severity, compared with the item as first written. Every other merged report stays on the item. The verifier, the report and the run view all show it ("Also reported as").
  - A raised severity keeps the first one ("[critical; first reported as low]").
  - A new report matches an item by its first wording or any merged wording, within a round and across rounds.
- **One prompt budget, fairly shared, and every cut is a gap.** Each prompt's inputs are measured first, then given their share of the prompt's room (160,000 characters):
  - A draft to revise is carried whole.
  - Short inputs keep all they need.
  - No input is cut to nothing.
  - A single answer (at most 64,000 characters) is never cut on its own.
  Every cut is marked in the prompt and listed as a gap of the run.
- **Limits never drop work.** Items over a Review's for-each limit go on as unverified and "not checked", and the run says how many.
- **A repeat until nothing new** ends only on a round in which every call came back and found nothing new. Running out of rounds first is a gap ("more may remain").
- **A final Rank** names every answer tied for first, and names no winner (the run fails) when no vote counted.
- **A final Review** leads with the work it reviewed.
- **Completion.** `finish` for graph runs is blocked only by quarantined evidence; the planner decides completion.
- **Persistence.** A custom workflow is stored as a Council tab anchor carrying `draft.graph` (template `custom`). No persisted enum grows, so older builds still restore the session.
- **The synthesizer** defaults to the first eligible family (Claude).

**Build + Review.**
- It stays on its existing Orca executor. It opens as a conversation tab in a local or SSH workspace, through one entry (`build-review-entry.ts`); the start dialog only asks for a workspace when the current one cannot hold a tab, and the started run then opens as a tab there.
- Its semantics already match the model: build → reviewers → fix → up to N rounds. A failed or missing reviewer verdict fails the run and never approves.
- No graph template builds `build-review` any more (it never ran). The id stays in `WorkflowTemplateId`, so a saved spec naming it normalizes the same way and graph admission still refuses it: it cannot run on the wrong executor.
- **Follow-ups, not done here:**
  1. Parallel reviewers. This needs one mailbox pump dispatching reports to several live workers, like `LocalRunRunner`'s, replacing the single `pipeline.reviewer` owner.
  2. Surface "needs you" in the tab and sidebar when a worker's hook row is `waiting` or `blocked`, or its turn ended without a report. The worker card already shows it.
  3. Run it on the interpreter through a write executor built on `workerStart`.

**Removed:** the per-preset Council and Discover setup screens (`LocalWorkflowSetup` and 14 files only it reached; 3,748 lines). Legacy *run* views stay for runs recorded by earlier revisions, and the legacy programs stay replay-only.

**Found by live verification and fixed:**
1. **`localWorkflow.start` refused every graph draft.** Its schema is strict and required seats. The host-level probe could not see this; an RPC test now pins it.
2. **Grok's `strict` sandbox refuses to start** when `/var/run/docker.sock` is a symlink (Docker Desktop, OrbStack), as on laptop. Setup now marks Grok unavailable there, with that reason.
3. **Failure messages name their cause:** exit status plus the last line the CLI wrote to stderr.
4. **The Discover scout** now asks for as few areas as cover the focus. It used to split two files into six areas, which meant 18 finder jobs.
5. **The default synthesizer** was the rotation's third family (see above).

**Live runs** use real CLIs through the production `LocalWorkflowHost` (`config/scripts/workflows/probe-graph-host.ts`: real catalog, preflight, launcher, attestation, journal and projection; team: Claude + Codex, Grok excluded by the sandbox check, Gemini without a key):

| Run | Graph | Result | Time | Replay |
| --- | --- | --- | --- | --- |
| Compile Sal's sentence | → research Do ×4 → critics Review ×2 → final Synthesize ×1 | valid, 0 problems; one warning (the critics share the researchers' model families) | one Claude call | — |
| Council | answer ×3 → blind rank ×3 → chair | completed, gaps named (Grok seat failed, before the sandbox check) | 68 s | same result, 0 new attempts |
| Research panel (compiled) | 4 researchers → 2 critics → synthesizer | completed, no gaps; critics' FAIL verdicts corrected in the synthesis | 638 s | same result, 0 new attempts |
| Discover (thorough) on `graph-items.ts` + `graph-parse.ts` | scout → find ×3 per area → verify per item, repeat until nothing new (2 rounds) → report | completed; 78 + 42 items, 32 confirmed; gaps: items set aside by the verify limit of 16 | 3,381 s | same result, 0 new attempts |

**Discover on its own code.** The Discover run above was pointed at the workflow system's own parsers, and its confirmed findings were real. It found:
- an invalid final verdict that resurrected an earlier one
- verdict prose read as a pass
- missing verdict words
- ballot ordinals that were ignored
- a merge that kept the lower severity
- negated titles merged as duplicates
- blank placeholder items

All are fixed with regression tests (`e79728279`). The same run showed the efficiency problems fixed above: too many scout areas, and each round waiting for the previous round's verification.

**Cross-model review** (GPT-5.6 Sol at xhigh, codex-critic, one continuing session). Round 1 found 5 blockers and 4 should-fix items (WG-001…009):
- an empty final result reported as completed
- a rejected draft reused after a failed revision
- a failed review round dropping its items
- the call bound in nothing-new repeats
- approval with missing votes
- supersede in nothing-new repeats
- a ballot without its heading
- the projection of paused calls
- a review of a review

All are fixed in `0d4e83c99`, each with a regression test in `graph-review-fixes.test.ts`, and the reviewer confirmed that legacy behavior is unchanged.

**Discover on the runtime itself.** A second live Discover run was pointed at `graph-loop`, `-plan`, `-step`, `-supersede`, `-outcome` and `-checkpoint`:
- It covered 6 files in 3,291 s. The first run took 3,381 s for 2 files, so the two efficiency fixes worked.
- The scout named 3 areas, not 6.
- Round 2's finders ran while round 1 was still being verified.
- It confirmed 27 findings (17 distinct) and refuted 2. Replay gave the same result with 0 new attempts.

Fixed in `ae504787b`, each with a regression test in `graph-discover-fixes.test.ts` that fails on the code it reviewed:
- findings past the verify limit vanished from the report
- a dry search failed when its Review was the final step
- a loop Review that never ran counted as advisory
- a round with a failed finder was taken as convergence
- a search that never converged was not a gap
- the budget cut drafts, and dropped whole inputs without a gap
- a tie or a zero-vote ranking still named a winner
- a final Review dropped the work it reviewed
- an empty Rank was not a gap
- an approved loop revised blind when its Review could not run
- a retried loop Review could wedge recovery
- a majority was shown as "all reviewers"

Kept on purpose:
- An unapproved final Review completes, with the gap in bold.
- The synthesizer decides what its report says, and every finding stays in the run view.
- One finding needs a manual database edit to arise, so it is left as defence in depth.

**Cross-model review, rounds 2–4.** All nine round-1 findings were confirmed fixed. Round 2 found that the negation guard could still merge opposite claims (NEW-001), plus three smaller issues. Round 3 found that the first fix still dropped same-title reports and anything past a private cap. The design that closed it is the rule above: keep every non-identical report, and cut only through the one budget.

Round 5, the cap, found one more path of the same kind: the severity was raised before the exact-copy check. It also found four smaller issues:
- a report matching only a merged wording was treated as new
- a final Review of a whole list showed nothing of the list
- cuts of same-titled inputs were counted once
- a 1–1 split was called "a majority"

All are fixed in `cbd5099a4`, and each regression fails on the commit reviewed. The loop hit its cap with that blocker open until this fix, so the fix was escalated to a different lineage (Grok 4.6, grok-critic). It confirmed all five fixes with 0 blockers. Its broader attack on the whole subsystem timed out twice, so it was re-run as three narrow briefs (replay invariant, prompt budget, loop and outcome states).

Three of those findings reproduced and are fixed in `3264fe802`:
- each failed round of a loop review is named in the gaps
- the budget refuses a render whose measure and fit passes differ
- an empty draft stops an approved loop

The rest did not reproduce against the real planner. In Grok's second pass it verified the three fixes, accepted all seven refutations by tracing the production code, and reported **0 blockers**. Both review lineages end with no open blocker.


## 10. Improve: keep making the work better until more attempts stop helping (2026-09-22)

**What it is.** A third mode of the one repeat modifier, `until: 'plateau'`, on a Do → Rank pair. It
adds no engine and no step kind: the planner, the durable calls, replay and the run view are the
ones above. The template (`shared/workflow-graph-improve.ts`) is two steps, `improve` (Do) and
`judge` (Rank), and the user types a prompt and presses Run. Every setting is optional.

**The loop** (`graph-improve-loop.ts`, decisions in `graph-improve-decide.ts`):

| Round | Improvers (the Do step's N agents, in parallel) | Judge (blind) | Kept |
|---|---|---|---|
| 1 | N first versions (one is `explore` when N ≥ 3) | ranks them when N ≥ 2; one version needs no judge | the winner becomes the **best version** |
| 2… | each gets the original task, the best version, the judges' notes; most `improve` it, some `explore` a different approach | the best version and the challengers, anonymised, the best version at a different position each round | a challenger **only if it wins**; a tie, an unsure JEV with no model vote, or no counted vote keeps the best version |
| plateau | after `patience` rounds in a row without a gain (default 2): one round where every improver takes a **fundamentally different approach** (unless exploring is low) | as above | stop when that round gains nothing too |

- **Never newer = better.** The incumbent is found by identity, never by recency or a marker.
  A failed round, a failed judge and an unsure judge all keep it.
- **No drift.** Every improver prompt and every judge (model ballot and JEV) is built from the
  original task; a version is only ever material, never the new task. The improvement
  instruction ("Keep it under 200 words") is part of the task the judges read too, so a version
  that ignores it cannot win on polish.
- **A challenger must clearly beat the best version.** Head to head is not transitive, so with
  several challengers JEV is told (privately; the answers stay anonymous) which answer is the
  best version so far, and it is unsure unless its top answer clearly beats that one too; the
  model judges then decide. A round whose judges could not vote says so, round one included.
- **Feedback has a target.** Every improver, from the first version on, sees what the judges
  count as better work (the person's "what good means", else the general rubric), so a first
  version and a round after an unjudged one aim at it too. Later improvers also get the judges'
  notes; pairwise JEV ballots name the rubric criteria that most often drove their comparisons,
  so a sure JEV decision is more useful than a bare win percentage.
- **Diversity.** The strongest losing version from an explorer (or round one's runner-up) is kept
  as the **alternative**; explorers develop it instead of starting from scratch. This is the
  smallest useful version of FunSearch's islands: two lines of search, the best and one other.
- **Stops**: plateau, the round limit (default 6, at most 10), or no first version at all
  (the only failure). Stopping at the limit while still improving is named as a gap.
- **Result**: the best version found, then "How this was found" (one line per round).

**Settings** (the Options panel; "Customize" opens the graph editor):
- Models: one model (default, the first available family) or multi-model (rotate families). One
  model working alone is judged by another family when one is available: a model prefers its own
  newest revision (seen live: Claude judging Claude preferred every revision JEV was unsure about).
- Candidates per round: 1 (default, sequential improvement) to 7 (Best of N each round).
- Rounds (1–10), stop after 1–4 rounds without gain, exploration low / normal / high.
- Judges: JEV · models if needed (default) / JEV and models / models only; what good means
  (bulleted lines are scored by JEV as separate criteria); an improvement instruction. A preset
  review rubric and how JEV compares are under Customize (the Judge step).
- Per seat: a **system prompt** (`WorkflowAgentSpec.system`) that leads everything the seat is
  asked, so seats of one family with different system prompts compete like different models.

**Configurable prompts** (`repeat.prompts`, optional; defaults in `shared/workflow-improve-prompts.ts`).
Improve's built-in instructions are five texts: one per improver role (`first`, `improve`,
`explore`, `divergent`) and the `rules` every version follows. A person may reword any of them under
Options → Prompts. Only their own wording is stored (normalization drops text equal to the built-in
wording), so the built-in wording can keep improving for everyone else. The run freezes the wording
in its snapshot, and the judging record notes which texts were reworded, with a digest of the
wording, so variants can be compared later. Like the check, a described change never adds, changes
or drops them (`settleCompiled`). Not rewordable: the line telling an explorer to develop the
alternative it is shown, because it describes what the prompt contains.
- **Only facts that were given** (default rule, 2026-09-23). Live runs on marketing copy invented
  product facts ("4K", "20 free renders") and kept them after the judges objected. The default rules
  now forbid invented specifics about the real product, people or world, allow a marked placeholder
  such as `[price]`, and keep fiction and hypotheticals the task asks for.

**Objective check** (`repeat.check`, optional; `graph-improve-check.ts`, `graph-improve-round.ts`,
host runner `graph-check.ts`). The strongest evaluator available beats AI opinion
(AlphaEvolve / FunSearch):
- **What runs.** A command the person typed runs on every new version, in the verified
  workspace folder, with no shell, a 180 s limit and 256 KB of output. The version is a private
  temp file (`{candidate}`, `$OMNI_CANDIDATE_FILE`), and its largest code block gets its own file
  (`{code}`, `$OMNI_CANDIDATE_CODE_FILE`). The command line is used exactly as typed (quoted
  spaces kept; on Windows a backslash escapes only `"`), `graph-check-launch.ts`.
- **Containment.** The check may run model-written code, so it gets a clean environment (tool
  locations and locale only, never the app's keys or tokens). It takes one of the run's process
  slots, is admitted by the run's guard like an agent call, and a time limit or Stop ends its whole
  process tree before the result settles; a stopped check records nothing. A start receipt
  (`check-starts.json`) is written before launch: a check whose result was lost is reported as
  interrupted, never run twice.
- **Precedence.** Exit 0 passes, and a last `SCORE: <number>` line ranks (higher wins). Passing
  beats failing, then a higher score beats a lower one; the judges decide only among versions the
  check cannot tell apart. `stopWhenPassing` stops as soon as the best version passes (when no
  score is reported).
- **Feedback.** Improvers are told the command, and in later rounds the best version's result:
  the failing output to fix, or the score to beat.
- **Unavailable checks.** A check that cannot run (program not found, no workspace) is marked
  unavailable and named as a gap, never counted as a quiet fail.
- **Replay.** Results are recorded per version in `checks.json`; replay and recovery never run the
  command again.
- **Only a person types a check.** Admission refuses a check without workspace access. A
  described change keeps the person's check exactly, even when the model's answer leaves it out,
  and can never add or change one (`settleCompiled`), so no model-written command ever runs; a
  change that removes the rounds says the check went with them. The command may run model-written
  code; the Options panel says so.

**Single model works end to end.** A judge's vote on its own model's answer among others' is still
set aside; when every answer is its own model's (one model improving its own work), no answer is
favoured, so the vote counts (`graphStandings`). The earlier rule that failed such a ranking is
retired; the same-family warning remains for model-only judging.

## 11. JEV judging foundation (2026-09-22)

- **One engine**: `main/structured-decisions/jev-rank.ts` ranks any answers by rubric scores
  (one call per answer, every criterion in it) or head to head (every pair in both orders;
  `auto` picks head to head up to 5 answers). It returns the order, scores, per-criterion scores
  and **unsure** with its reason: the top two within 0.5 on the 0–4 scale, or a head-to-head
  probability inside 0.2–0.8, or a preference that flips with the order shown. Given an
  `incumbent` (the answer to beat), head to head is also unsure unless the top answer clearly
  beats it. The band is the
  JEV Lab's (4,786 judgments against Opus: 27% disagreement inside it, 0.1% outside 0.1–0.9).
- **Pairwise reasons**: each comparison also identifies the rubric criterion that most strongly
  explains the preference. This adds no JEV calls; the ballot carries the leading criteria into
  Improve's next round.
- **One rubric format**: `shared/jev-rubric.ts`. Plain text; two or more bulleted lines become
  separately scored criteria; otherwise five general criteria.
- **JEV first** (`jev: {method: 'auto', only: true}`, the default for Improve, Best of N and
  Council): JEV judges alone when it is sure; when it is unsure or unavailable the step's model
  judges vote too. An unsure JEV then stands aside and the models decide, unless no model judge
  may compare some pair of answers (a judge never places its own family's answer among others,
  so with two families judging each other's work a Claude answer and a GPT answer have no
  common judge): then JEV, the only neutral voice, counts with them (`jevCounted` on the trail,
  `counted` in the judging record). Without it the lone other-family answer sat on the neutral
  midpoint and could never win (seen in the round-2 live run, Claude + GPT). JEV is advice,
  never a gate by itself.
- **The judging record** (`graph-judging-record.ts`): each settled run writes, per judged round,
  which model and system prompt wrote each answer, the placings, JEV's and each model's ballot,
  and their agreement (Improve marks the best version defending its place as `incumbent`, so a
  seat's defended win is not counted as a new answer's), to `<userData>/local-workflow-attempts/<run>/judging.json` and once to
  `workflow-judging.jsonl`. This is the evidence for learning which seats win and where JEV can
  be trusted alone.
- **Not JEV's job**: Discover's verify step and Build + Review judge code by reading and running
  the workspace; JEV sees only text, so it is not offered there.

## 12. Find the best (2026-09-23)

Many options in, the best few out: the models come up with N options (default 100), or the person
gives their own list (up to 200, one per line), JEV scores every one, and the best few meet head to
head. Template `find` (`shared/workflow-graph-find.ts`): an `options` Do step whose list is the pool
and a `judge` Rank step, with `spec.find = { count, versions?, items?, top, keep? }`. Like Improve it is not a new
engine: `runFindBest` (`graph-find.ts`) plans the pipeline over those two steps, and the report is
`graph-find-outcome.ts`.

- **Pool.** Generated options come in batches, one list call each (up to 20 per call, at most 8
  batches), rotating across the families that are set up. Each batch has its own angle (the
  obvious, the overlooked, the simplest, the most ambitious…), so a hundred options are not a
  hundred variations. Duplicates merge through the ordinary list merge. The person's list is used
  as given.
- **Screen.** One host-answered JEV call (`call.screen`, `graph-jev-screen.ts`) scores every option
  0–4, overall and on each line of the rubric, with `jevScreen` (`structured-decisions/jev-rank.ts`).
  JEV is cheap enough to read every option; no agent call is spent. A failed request is retried
  once; an option JEV still cannot score is left out and named, never guessed. The screen fails
  only when nothing could be scored, and then the run ends with JEV's reason.
- **Shortlists.** The top K overall, and, when the person wrote a rubric of two or more lines, the
  top K on each line.
- **Final.** The overall top K meet in the judge step with its usual JEV-first cascade. A tie goes
  to the higher screen score. When no judge can vote, the screen's order stands, as a gap.
- **Replay.** The screen is kept in the run's JEV record and replayed. Recovery never asks JEV
  again.
- **Complete versions (Best of N, folded in).** With `versions`, the `options` step is not a
  list: each of 2–8 agents writes one complete version from its own angle (Best of N's instruction
  and angles), and the pool is those versions. Judges read each version alone, never its angle or
  maker; when more versions than the final holds come back, JEV screens them first. The report
  shows the winning version whole, and the results files keep every version whole. Switching
  between options and versions rebuilds the step and resets the count to that mode's default; the
  person's own instruction for the step is kept. Best of N left the ＋ → Workflows picker; its
  template stays for drafts and next steps that already use it.
- **A check on complete versions.** A person may type a check for complete versions (`find.check`,
  the same command, placeholders, clean environment, process slots and records as Improve's
  check; only where the agents may read the workspace). Every version runs it
  (`graph-find-check.ts`), and passing, then a higher `SCORE:`, outranks every judge: the
  versions the check cannot tell apart go on to JEV and the judges, and the rest follow in check
  order. When the check leaves one version on top, no judge is asked. When no version passes, the
  judges choose among them all and that is a gap. A model can never set or change the check: a
  compiled workflow keeps the person's (`settleFindCheck`), and `omni find-best` has no check flag,
  because agents use it. The results files carry `check` and `check_score` columns.
- **GitHub facts for repositories.** When at least half of the options name a GitHub repository
  (`owner/name` as the first word, or a github.com link), the host asks GitHub about each one
  before the screen (`call.facts`, `graph-github-facts.ts`, through the app's `gh` runner, four
  at a time with the app's other GitHub work). The judges and JEV read one line of facts per
  repository: stars, forks, open issues and pull requests, last push, creation date, license,
  language, archived, fork, and where it moved. Never the description or topics: the owner writes
  those and could word them as instructions. The facts are recorded (`github-facts.json`) and
  replayed; a repository GitHub does not know is named as a gap, and when GitHub cannot be asked
  at all the run goes on with the text alone and says so. Generated options put `owner/name`
  first when an option is a repository. The results files carry the facts in a `github` column.
- **Keep many.** "Bring back" (`keep`, default 10, up to 100) is how many of the best the report
  lists, apart from how many meet in the final (`top`, up to 8). The order is the winner, the other
  finalists by their place in the final, then the rest by JEV's score, and last any option JEV
  could not score (`findRows`, `graph-find-rows.ts`). A run from before `keep` brings back `top`.
- **Results files.** A completed run saves every option and every score in its workspace, in
  `.omni/find/<date>-<time>-<words of the task>-<run id>.md` and `.csv`
  (`find-results-files.ts`, `find-results-output.ts`). The Markdown file holds what was asked, the
  rubric, the report and every option best first; the CSV has one row per option with its JEV
  score, its score on each rubric line, its place in the final and whether it was kept, and opens
  in Excel, Sheets and Numbers (UTF-8 mark; text a spreadsheet would run as a formula is kept as
  text). The folder ignores itself in a repository (`.omni/find/.gitignore` is `*`).
- **Written once, safely.** Admission freezes the workspace's identity (`host.resultsRoot`, apart
  from `workspaceRoot`, so saving never implies agents may read the workspace). The first view
  after completion writes the files through the Council output's write-once publisher
  (`frozen-folder-file.ts`: temp file, hard link, same bytes count as written, a different file is
  never replaced), creating the folder one part at a time and refusing a part that is a link or a
  workspace that was moved or replaced. Where they went is recorded in the run's attempts folder
  (`find-results.json`), so later views never write again and a person who tidies or edits the
  files is not undone. A failure shows on the run and is tried again on the next view; startup
  reconciliation finishes a write interrupted by a quit. The run view shows the files with "Show
  in folder".
- **Next steps.** A completed run's kept options can be ticked and acted on (section 15):
  Improve one, Combine two to five, or Look closer at up to five, each opened to review; nothing
  runs until Start.
- **Not yet:** a combined option that must beat the best original inside one run, and a facts
  check for claims.

## 13. The rubric library (2026-09-23)

One library of reusable rubrics for every judging step: Improve, Find the best, Best of N, Council,
Build + Review and next-step reviews. It extends the review rubrics instead of adding a second
store (`shared/rubric-library.ts`, `shared/rubric-kinds.ts`).

- **Built in.** The four review presets, plus eleven starters: ad copy, landing page, customer
  reply, GitHub repository, code change, business idea, product name, research answer, plan, social
  post signal and prompt output. Each is a sentence on what is judged, then one criterion per line;
  JEV scores every line on its own, which also gives Find the best its per-line shortlists.
- **The person's own.** Saved in settings (`reviewRubrics`, up to 200), each with the kind of thing
  it judges; the picker groups the library as "Yours", then the built-ins by kind. Editing a rubric
  and saving it under a name keeps its kind.
- **Shared by file.** "Export your rubrics" writes an `omni-rubrics` JSON file; "Import rubrics"
  reads one. Imported rubrics replace saved ones of the same name, and nothing saved is dropped for
  room: rubrics past the limit are left out and counted. The files go through the new text-file
  dialogs (`export:save-text`, `export:open-text`), where the person picks every path.
- **On the wire.** Starters travel as `custom` rubrics with their name and text, so hosts that
  already read rubrics read them, and the Build + Review RPC's id list is unchanged.
- **In a workflow.** The chosen rubric sits in the judging step's instruction (`Rubric: <name>`
  plus its text), beside anything else that matters in the person's own words. Improve and Find
  the best show it as "What good means"; their Options summaries name it.

## 14. `omni find-best`: Find the best from a terminal or a chat (2026-09-23)

`omni find` was already the browser's find-element command, so this is `omni find-best`.

- **The app owns the conversation.** The CLI calls `localWorkflow.find` (desktop callers only,
  like every workflow method). The runtime resolves the workspace with the same local-host and
  card-bound checks as a run started in the app, then asks the window
  (`openLocalWorkflowFind`, relayed over `ui:startLocalWorkflowFind` /
  `localWorkflow:findReply`; only that window's answer to that request counts, and a closed,
  crashed or reloading window or a two-minute wait ends it with a reason). The renderer opens
  a Find the best conversation in the background, without taking the person's view, and starts
  it exactly as Start does: start request on the anchor, then `localWorkflow.start`, then the
  execution id. The run therefore has the normal conversation anchor and admission, and the
  person can open or stop it in the app.
- **Settings.** `--count`, `--versions <n>`, `--list <file|->`, `--keep`, `--final`,
  `--rubric <name>` (built-in or saved; an unknown name fails with the names there are) and
  `--good <text>`, checked by `localWorkflowFindRequestSchema` before anything starts and turned
  into the same spec the Options panel builds (`localWorkflowFindSpec`).
- **Following.** The CLI reads `localWorkflow.show` every three seconds and prints each new stage
  to stderr; the report and the saved results files go to stdout. `--json` returns the report,
  the winner, every row with its scores, and `saved`. Ctrl-C stops following, not the run;
  `--no-follow` returns as soon as it starts.

## 15. Act on the results: start a session with the chosen ones (2026-09-23)

A workflow's results are usually the start of the work, not the end: the person picks the ones
that matter and hands them to an agent to act on.

- **What can be chosen** (`workflow-results-candidates.ts`). Once a run settles: Find the best's
  kept options, best first, with the winner ticked; a graph run's reviewed items (Discover's
  Verify), each once as its latest round judged it, held-up ones first and ticked, in JEV's order
  within each verdict when JEV screened the run, and the ones JEV set aside as non-findings last,
  unticked and marked so; a run with no
  review step offers its last list, none ticked; an older Discover report offers every item,
  all ticked because each held up. Council and Improve answers have no list, so they offer
  nothing here (their follow-up stays as it was).
- **The panel** ("Act on the results", under the run) lists them with a checkbox each, Select
  all / Clear, and what the run learned about each: winner, final place, JEV score, the
  person's check, verdict, severity, JEV triage score, location. For Find the best the chosen
  options also open Improve (one), Combine (two to five) or Look closer (a Council, up to five)
  to review and start (`shared/find-next-step.ts`).
- **Start a session** opens a dialog: the agent (the ones detected on the workspace's host),
  its model, effort and account, and the instruction. The instruction starts as the usual one for
  the kind of result (Find: put it to work, compare, research; Discover: fix, plan the fixes,
  double-check) and is the person's to edit. Left empty, the session opens in the terminal with
  the results typed into its composer and not sent, for the person to finish there (a chat
  view would drop or refuse an unsent draft). The session opens in the conversation's tab group
  through the same path as a continuation (`launchAgentSessionContinuation`, now with an
  optional `promptDelivery`).
- **The first message** (`workflow-results-session-prompt.ts`): which run it came from (preset
  and execution id), the request it answered, a line saying everything up to the last
  "Instruction:" is untrusted run output (and that locations were reported by a model and must
  be re-checked), the saved results files, each chosen result whole with its standing and a
  workspace-relative `path:line` (a location outside the workspace is shown as reported and
  says so), then the instruction. Details over 6,000 characters are cut, and when the whole is
  over 60,000 each detail is cut to 400 and the saved files are named as where they are in full;
  still over, it refuses and asks for fewer.
- **Not yet:** saving the chosen results to Jira or Slite for later.

## 16. Decision contracts (2026-09-24)

Every judgement JEV makes in a workflow now has a written, versioned description
(`shared/decision-contracts/`). Version 1 of each contract states today's rules exactly; a run
reads the contracts frozen when it was admitted.

- **A contract** says what the decision serves, what JEV is shown, the gates (rule or JEV), where
  the criteria come from, when JEV counts as sure (`confidence`), what happens when its answer is
  unknown (`unknown.fallback`: the model judges decide, keep and verify, keep the best version, keep
  the chair, run the full workflow, or report a gap; never a low score), which mistake costs more
  (`harm`), and the evidence it needs before it counts as checked (`target`).
- **Decision kinds and v1 contracts.** Rank ballot (`council-peer-rank`, `improve-judge`,
  `find-final`), Find's screen (`find-screen`), Discover's set-aside (`discover-set-aside`),
  Decide's shortlist (`decide-shortlist`), compare line (`decide-compare-line`), final check
  (`council-final-check`, `decide-final-check`) and one-answer route (`decide-one-answer`), plus a
  `generic-<kind>@1` for each kind, used outside the templates.
- **Decision points.** `workflowDecisionPoints(spec)` lists the JEV decisions a spec makes, keyed
  like the calls the runtime records (`<step>/ballot`, `<step>/line`, `<step>/set-aside`,
  `<step>/shortlist`, `<judge>/screen`, `final-check`, `route`); `resolveDecisionContracts(spec)`
  maps each to the template's contract for that kind, else the generic one. Build + Review, the
  research panel and Investigate make no JEV decision.
- **One source for the thresholds.** `JEV_SCORE_MARGIN`, `JEV_UNSURE_BAND`, the pairwise cut-off
  and `ONE_ANSWER_QUESTION` live in `shared/jev-confidence.ts`; the runtime and the benchmark kit
  import them from there, so a contract cannot drift from what runs.
- **Frozen once published.** `decision-contract-digests.json` holds each version's content digest;
  the test fails if one changes, so a new rule is always a new version. `LEGACY_CONTRACTS` stays
  pinned to @1 for runs frozen before contracts existed.
- **Frozen at admission (decision rules 1).** Admission saves `host.decisionRules` and
  `host.contracts` (each decision point's ref) beside the Find and Improve rules. Every JEV request
  then names its contract (`contract`), so a new run never reuses a ballot judged under another
  version. Ballots read the contract's ranking policy when asked (stored with the ballot, so a
  replay reuses it); Discover's set-aside line, Decide's shortlist line and the one-answer band
  are read when the plan is made. A run frozen before decision rules has no `contract` key and
  plans under `LEGACY_CONTRACTS`, byte for byte as it ran (`graph-decision-rules-legacy.test.ts`
  pins nine scenarios taken before the change). A replay refuses newer rules, an unknown ref, a
  contract of the wrong kind or one this build cannot run, and a point without its contract.
- **find-screen@2 (new Find runs).** @1 left an option JEV could not score out of the final, as
  if it scored low. @2 keeps @1's confidence policy and sends such an option to the final unscored
  while the final holds fewer than 8; every one is named with JEV's reason as a gap, any the final
  had no room for are named as not compared, and results mark it "not scored by JEV". Runs frozen
  with @1 keep it.
- **Next.** Golden sets and calibration, the completed judging record with `omni workflow stats`,
  and the plain-words note in the run view.

## 17. Discover: shadow JEV verify (2026-09-26)

Measured on omni-ide's frozen seeded set (`config/scripts/workflows/benchmark/discover-seeded`,
12 bugs, answer key v2): real Discover runs confirmed only 4 of 12 bugs (precision 0.29–0.44,
41–46 min, about 5M input tokens), yet the finders had found 11–12 of 12; 35–47 of 50–62 targets
stayed unverified, because verification capacity and order are the bottleneck. One batched JEV
yes/no per target over its code (0.6 s, about $0.001 for 50–62 targets) had AUC 0.76–0.79 and, at
p ≥ 0.9, caught 7–9 of 12 at precision 0.58–0.64; the screen's 0–4 score had AUC 0.47 on the same
run. Before JEV changes any verdict, it is measured on real runs: that is this shadow mode.

- **Turn it on.** A review for-each step takes `jevVerify: { "mode": "shadow" }`; no template
  ships shadow (Discover ships `live`, §17.1). For Discover from a terminal:
  `omni workflow run --template discover --prompt-file goal.md --spec-file shadow.json --json`
  with `shadow.json` = `{"steps":{"verify":{"jevVerify":{"mode":"shadow"}}}}`. `live` is below;
  any other mode is refused at validation.
- **What it asks.** In every round of the review, one host call (`<step>[/rN]/jev-verify`) asks JEV one
  NOUL question per item — every item of the round, not only the verify limit: "A reviewer reports
  a defect at <location>: <title>. <detail> … Looking at the code, is this a real, in-scope defect
  (the scope is state.scope) that the reviewer describes correctly?" The state holds the goal and
  the brief's "What counts" section, and for each item the file's numbered lines ±40 around the
  cited `path:line`, read from the workspace (bounded; an unreadable file leaves the report on its
  own). Questions go in as few requests as the provider's 64 KiB / 64-question limits allow.
- **What it records.** Each target's probability (`GraphTarget.jevVerify`, `jevVerify` in
  `omni workflow run --json` targets), the run's JEV record (`jev-ballots.json`, replayed by
  recovery), and a `verify` gate line in the judging record with the probabilities, counts, model,
  tokens and time, so `omni workflow stats` prices it with the other gates. Contract
  `discover-verify@1` (`generic-finding-verify@1` outside the template; kind `finding-verify`,
  NOUL, uncalibrated) is frozen at admission.
- **What it never does.** The call is kept off the step's calls, so no step waits for it; tallies,
  order, merging, escalation, reviewer dispatch, prompts, the report, gaps and loop decisions are
  those of the same run without it (`graph-jev-verify-plan.test.ts`). A failure, time-out, the kill
  switches (`JEV_DECISIONS_DISABLED`, `OMNI_STRUCTURED_DECISIONS_KILL`) or a missing key is recorded
  as no probability, never as a "no", and never fails the run.

### 17.1 Live JEV verify (2026-09-27)

Superseded as the default by discard-only live verify (17.2); a run frozen under
`discover-verify@2` keeps this rule, and a step that sets `confirmAt` still confirms by it.

Shadow data backed one rule, and live mode runs exactly that rule: keep every verdict the
reviewers reached, and confirm an item they left unverified when JEV's probability is at least
`confirmAt`.

- **Evidence.** Benchmark on the same seeded storefront (12 bugs, answer key v2). Six real
  `omni workflow run --template discover` runs on build 1.12.18-28662acf2655, one at a time, each
  with shadow verify on. JEV recorded p on every target in all 6 runs: pooled AUC 0.82 over 369
  targets (117 real). In the 3 runs where the workflow under-confirmed, applying the rule raised
  recall from 0.42/0.33/0.58 to 0.75/0.75/0.75, with precision equal or better (0.44→0.61,
  0.40→0.55, 0.41→0.43). In the 3 strong runs (recall 0.92) it changed nothing. JEV alone at
  ≥ 0.9 had precision 0.70–0.91. The cost was about $0.001 and under 1 s per run.
- **On by default in Discover (2026-09-27).** The template's `verify` carries
  `jevVerify: { mode: 'live' }` at the default `confirmAt`, so Discover admission freezes
  `discover-verify@2` (`verify/verify`). Other templates do not ship it. Any review for-each step
  can take `{"steps":{"verify":{"jevVerify":{"mode":"live"}}}}` as a `--spec-file` or in the
  template editor; `{"steps":{"verify":{"jevVerify":null}}}` turns it off, `{"mode":"shadow"}`
  records only. Why default-on: the six storefront runs above, plus two real Discover runs on a
  25.8k-line repository, where shadow AUC was 0.91–0.94 and the rule took recall from 0/12 to 5/12
  and from 8/12 to 11/12 at precision 1.00; strong runs were unchanged, and the cost stayed about
  $0.001 and under 1 s per run. With JEV unavailable (no key, kill switch) the run is the one it was
  before this default: no promotions, no gap, no negative verdict. `confirmAt` defaults to 0.9 (`JEV_VERIFY_CONFIRM_AT`); a step may set any value from 0.8
  to 0.99, and validation refuses anything else. Shadow mode behaves exactly as before.
- **The rule.** Once the round's reviewers have given their verdicts, a target still `unverified`
  whose p ≥ `confirmAt` becomes `confirmed` with `confirmedBy: 'jev'`, and its `jevVerify` keeps
  the probability. This includes a target over the limit or set aside by a screen. JEV never
  changes a reviewer's confirmed or refuted verdict, never refutes and never sets an item aside. A
  target with no JEV answer is untouched. One exception keeps its current rule: a page-fed item
  the app found no quote for (`webUnbacked`) stays unverified.
- **Ordering.** In live mode the round's verdicts wait for the JEV call. The step stays active
  until the call settles, so the report and anything that reads the round's tallies always see
  the promotions. Each JEV request is bounded by its own deadline (`REQUEST_TIMEOUT_MS`). A failure,
  time-out, kill switch or missing key promotes nothing: the run is then identical to one without
  JEV, and it is never failed and never given a negative verdict. Shadow mode still never waits.
- **The loop.** Discover's nothing-new rule is unchanged. It counts new findings from Find, and a
  promotion is not a new finding.
- **What the report sees.** JEV-confirmed items are listed under Confirmed, and each one is
  marked "confirmed by JEV (p 0.97), not by a reviewer" so a reader can tell it apart from a
  reviewer's confirmation. They are also counted among the results the ranked write-up must rank.
  `omni workflow run --json` targets carry `confirmedBy: "jev"` beside `jevVerify`, and the step
  log names each promoted key with its p.
- **Contract and record.** A live verify point resolves to `discover-verify@2` (outside the
  template, `generic-finding-verify@2`); shadow stays on @1. Like every other contract it is frozen
  at admission, and its `confirm` gate states the threshold rule. The request carries `confirmAt`,
  and so does the JEV record. The judging record's `verify` gate line gets `decision: confirmed` or
  `none confirmed`, `confirmAt`, the `confirmed` keys and `counts.confirmed`. `omni workflow
  stats` sums the counts as "JEV confirmed N items the reviewers left unverified".

### 17.2 Live JEV verify discards only (2026-09-28)

Live mode now sets aside and no longer confirms by default: JEV may discard, never confirm.

- **Evidence.** JEV Lab Experiments 5–6 (Slite "JEV Lab", 2026-09-28): 712 candidate findings from
  12 real Discover runs (seeded storefront and seeded workqueue). At p ≤ 0.1 JEV was right every
  time: none of the 32+30 storefront and 9+10 workqueue items it would set aside was a seeded bug,
  text-only or with code. At p ≥ 0.9 its confirmations matched a seeded bug only 51–79% of the time
  (33–49% of them matched none).
- **The rule.** Once the round's reviewers have given their verdicts, a target still `unverified`
  whose p ≤ `rejectAt` becomes `refuted` with `refutedBy: 'jev'`, and its `jevVerify` keeps the
  probability; with `confirmAt` set, one at p ≥ `confirmAt` is confirmed as in 17.1. Which
  thresholds apply: a live step that sets neither gets `rejectAt` 0.1 (`JEV_VERIFY_REJECT_AT`) and
  never confirms; `{mode: 'live', confirmAt}` keeps 17.1's confirm-only rule and never sets aside;
  `{mode: 'live', rejectAt}` only sets aside; both set do both. The Discover template sets
  `rejectAt: 0.1` explicitly, so a copy of it discards on purpose. This is a deliberate change for
  saved specs too: a saved Discover copy that says only `{mode: 'live'}` confirmed at 0.9 before
  and, on any new run, now sets aside at 0.1 and never confirms (runs already frozen under @2 keep
  @2's rule). A step may set `rejectAt`
  0.01–0.2 (`JEV_VERIFY_REJECT_RANGE`) and `confirmAt` 0.8–0.99; validation refuses either out of
  range or not a number, and a `rejectAt` not below `confirmAt`. p 0 is an answer (set aside); a
  missing, non-numeric or non-finite probability is no answer and changes nothing. A JEV
  failure, an answer with an `error`, or one with no finite probability for any target is a
  complete no-op: no tally changes and no rule line in the log, the same run as without JEV; the
  gate line's `counts.scored` counts only finite probabilities for the items asked. A finding a
  root-cause merge folded several reports into (each asked on its own) is set aside only when
  every one of them has a finite p at or below `rejectAt`, at the highest of them, and confirmed
  only when every one is at or above `confirmAt`, at the lowest; otherwise it stays unverified.
  The log names each member and its p, and the gate line records them under `members`. A finding
  carrying a merged report whose exact title, location and detail JEV was not sent (the request
  carries each item's first report only) is never set aside or confirmed: it stays unverified, the
  log says "JEV left N items unverified that it would have decided…", and the gate line counts the
  unread reports under `unread`. JEV never
  changes a reviewer's confirmed or refuted verdict. Shadow mode is unchanged.
- **What decides, and where it shows.** The thresholds go into the hashed JEV request, and the
  round applies the request's thresholds, not the spec's or today's constants, so a replayed
  record applies the rule it was recorded under (a request recorded under @2 has no `rejectAt` and
  never sets aside). Each live round's log says the rule it ran ("live JEV verify sets aside at
  p <= 0.1 and never confirms"), the JEV call's own answer states it, and the judging record's
  gate line carries `rejectAt` and `confirmAt` as applied.
- **Downstream.** A JEV set-aside is a refutation to everything that reads tallies, and stays
  labelled: the report lists it under Refuted, marked "set aside by JEV (p 0.04), not refuted by a
  reviewer", even when no reviewer saw it; a review that is the run's last step marks it the same
  way in the outcome; the ranked write-up need not rank it; the step log names each key with its p;
  `omni workflow run --json` targets carry `refutedBy: "jev"`; the desktop results list and step
  detail show "Set aside by JEV (p 0.04)" instead of Refuted. Discover's nothing-new rule is
  unchanged: it counts new findings from Find, whatever their tally, so a set-aside neither ends
  nor extends the search.
- **Reversible by new evidence.** JEV only discarded what it saw. When a later round reports the
  item again with anything new (any report that is neither the one JEV judged nor an exact copy of
  one merged into it then, including a report of a repeat folded into it by a root-cause merge),
  the loop's aggregate puts it back to `unverified`, marks it `resurfaced` and keeps the p it was
  set aside at (`setAsideAt`), exactly as a screen's set-aside resurfaces: the report lists it
  under "Unverified after review: reported again after JEV set it aside" (or, for an item no
  reviewer saw, "Unverified: reported again after JEV set it aside, not checked") with the later
  report's detail and
  "JEV set it aside (p 0.05) before a later report it never saw", and the log says so. The
  desktop view, results list and `omni workflow run --json` read the same (`tally: "unverified"`,
  `resurfaced: true`, `setAsideAt`; shown as "Unverified: reported again after JEV set it aside
  (p 0.05)"). It is not sent to reviewers again. A reviewer's refutation stands.
- **Contract and record.** A live verify point resolves to `discover-verify@3`
  (`generic-finding-verify@3` outside the template), whose gates are `set-aside`, `confirm` (only
  with `confirmAt`) and `never-against`, with harm `false-no`. @2 stays published, and a run frozen
  under it keeps @2's rule (confirm at 0.9, never set aside), so its JEV request and record match.
  The request and the judging record carry `rejectAt`; the `verify` gate line gets `decision: set
  aside` or `none set aside`, the `refuted` keys and `counts.refuted`, and `omni workflow stats`
  adds "JEV set aside N items the reviewers left unverified".

## 18. Seats: capacity-aware defaults, launch-failure substitution, degraded runs (2026-09-27)

In real Discover runs every call routed to Codex failed at once (0/76, 0/62 and 0/34 in the worst
runs). The default team took the first eligible account per route, which for Codex is
`system:codex` (`~/.codex`), and eligibility checked only the CLI and its sign-in. At the time,
`~/.codex` was at 100% of its 5-hour window while the managed Codex accounts had used 0–6% of
their week. Every finding sent to a Codex reviewer stayed unverified, no other account or model
family was tried, and the run still read "completed".

- **Default seats** (`local-workflow-host-setup.ts`, `shared/local-workflow-seat-capacity.ts`).
  Setup first brings stale account readings up to date, waiting at most 5 s. Per route it then
  picks the eligible account with the most fresh, verified capacity, taking the tighter of the
  5-hour and weekly windows, with ties broken by account id. Only a reading at most 5 minutes old
  with room left counts. Limited, stale, signed-out and unknown accounts never count. The system
  login is one candidate like any other. When no account is verified, setup keeps the old choice:
  the first eligible account that is not known to be limited.
- **Admission** (`local-workflow-graph-seat-admission.ts`). The seats the team names are kept as
  chosen, including a person's or a spec's explicit choice. The run freezes `graph.seatRules`
  (`SEAT_RULES` = 1). For each seat it also freezes a spare on every other eligible account of the
  same family, with the same model and effort, verified like any seat. Spares are not preflighted.
  A Claude or Codex seat whose account had no fresh verified capacity is named in the run's gaps.
- **Launch failure** (`workflow-launch-failure.ts`). A call failed at launch when every attempt
  it made in the run either launched no process (`WorkflowNoLaunchError`) or had its process
  stopped by the provider on the account: a usage or credit limit, or a sign-in failure. The
  provider's own error text is now kept in the failure (Codex `error`/`turn.failed`, Claude
  `is_error`). Rejected answers (empty, not JSON, off-schema, semantics), timeouts, overflow and
  everything else are content or host failures and are never moved.
- **Substitution** (`graph-seat-substitution.ts`, `graph-program.ts`). A call that failed at
  launch runs once more as `<call>~<seat>`. It goes to the spare of its own family with the most
  fresh capacity at that moment, else to the first seat of another family that is not known to
  be limited or signed out, taken from the step's own seats first. Gemini takes Do calls only. The
  substitute is never moved again. A recorded substitute is reused on resume, recovery and replay.
  The substitute's call appears among the run's calls, and a gap line names the move, for example
  "Verify: 12 calls could not start on Codex (…) and ran on another Codex account instead."
- **Degraded** (`graphSeatOutcome`). A call that failed at launch and that no seat took is lost.
  A run that lost calls gets a gap line per step and `degraded: { lostCalls, steps }` on
  `graphRun`, in `omni workflow run --json`, and in a stderr line ("completed degraded"). Its state
  stays `completed`, because the final step did produce a result.
- **Not changed.** Runs admitted before seat rules plan, replay and project exactly as they ran.
  Calls that ran and failed on content, the retry budget (two attempts per run, one left for
  Retry), the call limit (a substitute counts against it) and every model, prompt and step are
  unchanged.
