/**
 * Live proof for workflow graphs: the production LocalWorkflowHost (admission, catalog, provider
 * launch, attestation, durable journal, projection) driving the real CLIs, with only the account
 * settings lookup and the workspace resolver stubbed. Usage:
 *
 *   npx --yes tsx config/scripts/workflows/probe-graph-host.ts <council|discover|research|improve|find|compile> <outDir> [workspace]
 *   (PROBE_PROMPT=<goal> overrides the mode's built-in prompt. Improve also reads PROBE_ROUNDS,
 *   PROBE_CANDIDATES, PROBE_MULTI=1, PROBE_CHECK=<command>, which runs in [workspace], and
 *   PROBE_PROMPTS=<JSON of reworded Improve prompts>.)
 *
 * Writes <outDir>/report.json (final view, per-step states, attempts, launches) and replays the
 * completed run on a fresh host to prove it launches nothing and returns the same result.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setAppEnvironment } from '../../../src/shared/app-environment'
import { createLocalWorkflowGraphDraft } from '../../../src/shared/local-workflow-draft'
import type { LocalWorkflowView } from '../../../src/shared/local-workflow-view'
import type { WorkflowSpec } from '../../../src/shared/workflow-graph'
import { compileWorkflowDescription } from '../../../src/shared/workflow-graph-compile'
import { workflowTemplate } from '../../../src/shared/workflow-graph-templates'
import { probeFindSpec, probeImproveSpec } from './probe-graph-specs'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'
import { LocalWorkflowHost } from '../../../src/main/runtime/workflow-script/local-workflow-host'
import {
  catalog,
  preflight
} from '../../../src/main/runtime/workflow-script/local-workflow-provider-catalog'
import {
  attestNativeResult,
  launch
} from '../../../src/main/runtime/workflow-script/local-workflow-provider-launch'
import { listLocalWorkflowScope } from '../../../src/main/runtime/workflow-script/local-workflow-scope'
import { captureWorkflowOwner } from '../../../src/main/runtime/workflow-script/workflow-owner-claim'
import { WorkflowScriptSlots } from '../../../src/main/runtime/workflow-script/workflow-script-slots'
import type { OrcaRuntimeService } from '../../../src/main/runtime/omni-runtime'

const SAMS_SENTENCE =
  'Have 4 agents independently research this, send their findings to 2 critics, then have one synthesizer produce the final answer using the research and criticism.'

const TASKS: Record<string, { prompt: string; access: 'workspace-read' | 'frozen' }> = {
  council: {
    prompt:
      'For a SQLite-backed job queue with several worker processes on one machine, should a worker claim jobs with an UPDATE ... RETURNING under BEGIN IMMEDIATE, or with optimistic version checks? Recommend one and say when the other wins. Under 250 words.',
    access: 'frozen'
  },
  discover: {
    prompt:
      'Find real defects in src/main/runtime/workflow-script/graph/graph-items.ts and src/main/runtime/workflow-script/graph/graph-parse.ts (list parsing, verdict parsing, ballot parsing, standings, duplicate detection). Look only at those two files and what they call.',
    access: 'workspace-read'
  },
  research: {
    prompt:
      'What is the most reliable way to make a long-running Node.js child process tree terminate completely on macOS when the parent is cancelled? Give concrete API calls.',
    access: 'frozen'
  },
  find: {
    prompt:
      'Business ideas a one-person software studio could start this month and grow to $10k a month within a year.',
    access: 'frozen'
  },
  improve: {
    prompt:
      'Write the opening paragraph (at most 80 words) of a landing page for OmniRogue, an AI video generation tool for independent creators. It must make a creator want to try it today: specific, vivid, honest, no hype words.',
    access: 'frozen'
  }
}

function claudeAsk(prompt: string): string {
  return execFileSync(join(homedir(), '.local/bin/claude'), ['-p', '--output-format', 'text'], {
    input: prompt,
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(homedir(), '.claude') },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 5 * 60_000
  })
}

function summarize(view: LocalWorkflowView) {
  return {
    state: view.state,
    error: view.error,
    steps: view.graphRun?.steps.map((step) => ({
      id: step.id,
      state: step.state,
      reason: step.reason,
      rounds: step.rounds.map((round) => ({
        round: round.round,
        state: round.state,
        calls: round.calls.map(
          (call) => `${call.callId}:${call.status}${call.verdict ? `:${call.verdict}` : ''}`
        ),
        items: round.items?.map((item) => `${item.title} (${item.location})`),
        targets: round.targets?.map(
          (target) => `${target.tally}: ${target.title} [${target.votes.join(',')}]`
        ),
        standings: round.standings?.map(
          (standing) =>
            `${standing.place}. ${standing.name} ${standing.averageRank} (${standing.votes})`
        ),
        approved: round.approved,
        notes: round.notes
      }))
    })),
    loop: view.graphRun?.loop,
    saved: view.graphRun?.find?.saved,
    gaps: view.graphRun?.gaps,
    calls: view.calls.map((call) => ({
      id: call.id,
      state: call.state,
      attempt: call.attempt,
      model: call.modelLabel,
      error: call.error,
      ms: call.endedAt && call.startedAt ? call.endedAt - call.startedAt : undefined
    })),
    result: view.result?.markdown
  }
}

async function main() {
  const [mode, outArg, workspaceArg] = process.argv.slice(2)
  if (
    !['council', 'discover', 'research', 'improve', 'find', 'compile'].includes(mode) ||
    !outArg
  ) {
    throw new Error(
      'Usage: probe-graph-host.ts <council|discover|research|improve|find|compile> <outDir> [workspace]'
    )
  }
  const out = resolve(outArg)
  mkdirSync(join(out, 'userData'), { recursive: true })
  setAppEnvironment({
    getPath: (name) =>
      name === 'userData' ? join(out, 'userData') : name === 'home' ? homedir() : tmpdir(),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-probe',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: (code) => process.exit(code),
    getAppMetrics: () => []
  })
  const workspace = {
    id: 'probe-workspace',
    path: resolve(workspaceArg ?? process.cwd()),
    label: 'probe'
  }
  const runtime = { getAgentAccountSettings: () => ({}) } as unknown as OrcaRuntimeService
  const database = new OrchestrationDb(join(out, 'orchestration.db'))
  const hostOptions = async () => {
    const owner = await captureWorkflowOwner('probe-host')
    return {
      db: database.db,
      owner,
      slots: new WorkflowScriptSlots(6),
      resolve: async () => workspace,
      catalog: () => catalog(runtime),
      listScope: async () => listLocalWorkflowScope(workspace.path),
      freezeScope: async () => ({ evidence: '', sources: [], coverage: [] }),
      preflight: (snapshot: Parameters<typeof preflight>[1]) => preflight(runtime, snapshot),
      attestNativeResult,
      launch: (
        snapshot: Parameters<typeof launch>[1],
        id: string,
        fence: number,
        observer: Parameters<typeof launch>[6]
      ) => launch(runtime, snapshot, id, fence, 'probe-host', owner.spawnToken, observer)
    }
  }
  const host = new LocalWorkflowHost(await hostOptions())
  const address = { worktree: 'probe', conversationId: `probe-${mode}` }
  const setup = await host.setup({
    ...address,
    preset: mode === 'discover' ? 'discover' : 'council'
  })
  const team = setup.graphTeam ?? []
  const routes = team.map((seat) => seat.agent)
  console.log(
    JSON.stringify({
      team: team.map((seat) => `${seat.agent}:${seat.accountId}`),
      unavailable: setup.catalog
        .filter((entry) => entry.unavailableReason)
        .map((entry) => `${entry.agent}: ${entry.unavailableReason}`)
    })
  )
  let spec: WorkflowSpec
  let compileReport: unknown
  if (mode === 'council') {
    spec = workflowTemplate('council', routes)
  } else if (mode === 'improve') {
    spec = probeImproveSpec(routes)
  } else if (mode === 'find') {
    spec = probeFindSpec(routes)
  } else if (mode === 'discover') {
    spec = workflowTemplate('discover', routes, { depth: 'thorough' })
  } else {
    const compiled = await compileWorkflowDescription({
      description: SAMS_SENTENCE,
      available: routes,
      ask: async (prompt) => claudeAsk(prompt)
    })
    if ('error' in compiled) {
      throw new Error(`Compile failed: ${compiled.error}`)
    }
    compileReport = compiled
    console.log(
      JSON.stringify({
        compiled: compiled.spec.steps.map(
          (step) => `${step.id}:${step.kind}x${step.agents.length}<-${step.inputs.join('+')}`
        ),
        problems: compiled.validation.problems,
        assumptions: compiled.assumptions
      })
    )
    spec = compiled.spec
    if (mode === 'compile') {
      writeFileSync(join(out, 'compile.json'), `${JSON.stringify(compiled, null, 2)}\n`)
      database.close()
      return
    }
  }
  // PROBE_PROMPT points a run at another goal, e.g. Discover on a different set of files.
  const task = {
    ...TASKS[mode],
    prompt: process.env.PROBE_PROMPT || TASKS[mode].prompt,
    // A check runs in the workspace, so the run must read it.
    ...(process.env.PROBE_CHECK ? { access: 'workspace-read' as const } : {})
  }
  const started = await host.start({
    ...address,
    preset: spec.template === 'discover' ? 'discover' : 'council',
    requestId: `request-${mode}`,
    draft: createLocalWorkflowGraphDraft({
      prompt: task.prompt,
      graph: { spec, team },
      access: task.access,
      concurrency: 6
    })
  })
  if ('rejected' in started) {
    throw new Error(`Start refused: ${started.reason}`)
  }
  const { executionId } = started
  const began = Date.now()
  const timeline: unknown[] = []
  let last = ''
  const final = await new Promise<LocalWorkflowView>((done) => {
    void host.watch({ ...address, executionId }, (view) => {
      const line =
        view.graphRun?.steps.map((step) => `${step.id}:${step.state}`).join(' ') ?? view.state
      if (line !== last) {
        last = line
        timeline.push({ at: Date.now() - began, state: view.state, steps: line })
        console.log(`${Math.round((Date.now() - began) / 1000)}s ${view.state} ${line}`)
      }
      if (['completed', 'failed', 'cancelled', 'recovery_required'].includes(view.state)) {
        done(view)
      }
    })
  })
  const attempts = database.db
    .prepare('SELECT call_id, ordinal, state FROM local_workflow_attempts ORDER BY rowid')
    .all()
  // Replay on a fresh host: the completed run is reconstructed from the journal.
  const replayHost = new LocalWorkflowHost(await hostOptions())
  const replayed = await replayHost.show({ ...address, executionId })
  const attemptsAfter = database.db
    .prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts')
    .get() as { count: number }
  const report = {
    mode,
    executionId,
    seconds: Math.round((Date.now() - began) / 1000),
    compile: compileReport,
    spec,
    view: summarize(final),
    timeline,
    attempts,
    replay: {
      sameResult: replayed.result?.markdown === final.result?.markdown,
      sameSaved:
        JSON.stringify(replayed.graphRun?.find?.saved) ===
        JSON.stringify(final.graphRun?.find?.saved),
      state: replayed.state,
      newAttempts: attemptsAfter.count - attempts.length
    }
  }
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    JSON.stringify({
      state: final.state,
      error: final.error,
      gaps: final.graphRun?.gaps,
      saved: final.graphRun?.find?.saved,
      seconds: report.seconds,
      replay: report.replay,
      report: join(out, 'report.json')
    })
  )
  database.close()
  process.exit(final.state === 'completed' ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
