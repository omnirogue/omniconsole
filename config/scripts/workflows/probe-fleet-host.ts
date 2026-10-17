/**
 * Live proof for a workflow placed on another computer: the production LocalWorkflowHost with
 * the real fleet placement (estate hosts file, fresh load reading, runtime probe), the real host
 * readiness and workspace copy, and the real dispatched seat launch over SSH. Only the account
 * settings lookup and the workspace resolver are stubbed, as in probe-graph-host.ts. Usage:
 *
 *   OMNI_ESTATE_HOSTS_FILE=<hosts.json> npx --yes tsx config/scripts/workflows/probe-fleet-host.ts <host> <outDir> [workspace]
 *   (PROBE_ROUTES=codex limits the seats; PROBE_PROMPT replaces the question; PROBE_REQUESTED_BY
 *   and PROBE_REQUEST are frozen with the run as an agent-launched run's requester and words.)
 *
 * Writes <outDir>/report.json: the frozen placement, `omni workflow status` for the run, the row
 * status, each attempt, and a replay on a fresh host that must launch nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setAppEnvironment } from '../../../src/shared/app-environment'
import { localWorkflowChangedEvent } from '../../../src/shared/local-workflow-changed'
import { createLocalWorkflowGraphDraft } from '../../../src/shared/local-workflow-draft'
import { localWorkflowRunSpec } from '../../../src/shared/local-workflow-run-request'
import type { LocalWorkflowView } from '../../../src/shared/local-workflow-view'
import type { WorkflowRoute } from '../../../src/shared/workflow-graph'
import type {
  WorkflowPlacement,
  WorkflowPlacementPick,
  WorkflowRunsOn
} from '../../../src/shared/local-workflow-placement'
import type { LocalWorkflowHostSnapshot } from '../../../src/main/runtime/workflow-script/local-workflow-host-snapshot'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'
import { placeLocalWorkflow } from '../../../src/main/runtime/workflow-script/local-workflow-fleet-placement'
import { LocalWorkflowHost } from '../../../src/main/runtime/workflow-script/local-workflow-host'
import { localWorkflowRunStatus } from '../../../src/main/runtime/workflow-script/local-workflow-run-status'
import {
  catalog,
  preflight
} from '../../../src/main/runtime/workflow-script/local-workflow-provider-catalog'
import {
  attestNativeResult,
  launch
} from '../../../src/main/runtime/workflow-script/local-workflow-provider-launch'
import { listLocalWorkflowScope } from '../../../src/main/runtime/workflow-script/local-workflow-scope'
import { readyWorkflowFleetDispatch } from '../../../src/main/runtime/workflow-script/workflow-fleet-dispatch'
import { launchWorkflowFleetSeats } from '../../../src/main/runtime/workflow-script/workflow-fleet-seat-launch'
import { captureWorkflowOwner } from '../../../src/main/runtime/workflow-script/workflow-owner-claim'
import { WorkflowScriptSlots } from '../../../src/main/runtime/workflow-script/workflow-script-slots'
import type { OrcaRuntimeService } from '../../../src/main/runtime/omni-runtime'

const QUESTION =
  'Read index.html in the workspace. Is this page usable by a screen-reader user? Name the single most important fix. Under 120 words.'

async function main() {
  const [hostName, outArg, workspaceArg] = process.argv.slice(2)
  if (!hostName || !outArg) {
    throw new Error('Usage: probe-fleet-host.ts <host> <outDir> [workspace]')
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
    const owner = await captureWorkflowOwner('probe-fleet-host')
    return {
      db: database.db,
      owner,
      slots: new WorkflowScriptSlots(4),
      resolve: async () => workspace,
      catalog: () => catalog(runtime),
      listScope: async () => listLocalWorkflowScope(workspace.path),
      freezeScope: async () => ({ evidence: '', sources: [], coverage: [] }),
      place: (runsOn: WorkflowRunsOn | undefined, pick?: WorkflowPlacementPick) =>
        placeLocalWorkflow(runsOn, {}, pick),
      dispatch: (placement: WorkflowPlacement, snapshot: LocalWorkflowHostSnapshot) =>
        readyWorkflowFleetDispatch(placement, snapshot),
      preflight: (snapshot: Parameters<typeof preflight>[1]) => preflight(runtime, snapshot),
      attestNativeResult,
      launch: (
        snapshot: Parameters<typeof launch>[1],
        id: string,
        fence: number,
        observer: Parameters<typeof launch>[6]
      ) =>
        snapshot.host.placement?.mode === 'dispatched-seats'
          ? launchWorkflowFleetSeats({
              snapshot,
              executionId: id,
              fence,
              hostId: 'probe-fleet-host',
              ownerIncarnation: owner.spawnToken,
              directory: join(out, 'userData', 'local-workflow-attempts', id),
              observer
            })
          : launch(runtime, snapshot, id, fence, 'probe-fleet-host', owner.spawnToken, observer)
    }
  }
  const host = new LocalWorkflowHost(await hostOptions())
  const address = { worktree: 'probe', conversationId: `probe-fleet-${hostName}` }
  const setup = await host.setup({ ...address, preset: 'council' })
  const only = process.env.PROBE_ROUTES?.split(',').filter(Boolean)
  const team = (setup.graphTeam ?? []).filter((seat) => !only || only.includes(seat.agent))
  const routes = team.map((seat) => seat.agent) as WorkflowRoute[]
  const prompt = process.env.PROBE_PROMPT || QUESTION
  // One family still gets two answers to rank, as `--spec-file` would give it.
  const spec = localWorkflowRunSpec(
    {
      template: 'council',
      prompt,
      ...(routes.length === 1
        ? { spec: { steps: { answer: { agents: [{ route: routes[0] }, { route: routes[0] }] } } } }
        : {})
    },
    routes
  )
  console.log(JSON.stringify({ team: team.map((seat) => `${seat.agent}:${seat.model ?? ''}`) }))
  const started = await host.start({
    ...address,
    preset: 'council',
    requestId: crypto.randomUUID(),
    draft: createLocalWorkflowGraphDraft({
      prompt,
      graph: { spec, team },
      access: 'workspace-read',
      concurrency: 4,
      runsOn: 'fleet',
      runsOnHost: hostName,
      ...(process.env.PROBE_REQUESTED_BY
        ? { requestedBy: process.env.PROBE_REQUESTED_BY, request: process.env.PROBE_REQUEST }
        : {})
    })
  })
  if ('rejected' in started) {
    writeFileSync(
      join(out, 'report.json'),
      `${JSON.stringify({ refused: started.reason }, null, 2)}\n`
    )
    throw new Error(`Start refused: ${started.reason}`)
  }
  const { executionId } = started
  const placed = localWorkflowRunStatus(database.db, host.project(executionId))
  console.log(JSON.stringify({ executionId, placement: placed.placement }))
  const began = Date.now()
  let last = ''
  const final = await new Promise<LocalWorkflowView>((done) => {
    void host.watch({ ...address, executionId }, (view) => {
      const line =
        view.graphRun?.steps.map((step) => `${step.id}:${step.state}`).join(' ') ?? view.state
      if (line !== last) {
        last = line
        console.log(`${Math.round((Date.now() - began) / 1000)}s ${view.state} ${line}`)
      }
      if (['completed', 'failed', 'cancelled', 'recovery_required'].includes(view.state)) {
        done(view)
      }
    })
  })
  const status = localWorkflowRunStatus(database.db, host.project(executionId))
  const attempts = database.db
    .prepare('SELECT call_id, ordinal, state FROM local_workflow_attempts ORDER BY rowid')
    .all()
  const replayed = await new LocalWorkflowHost(await hostOptions()).show({
    ...address,
    executionId
  })
  const attemptsAfter = database.db
    .prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts')
    .get() as { count: number }
  const report = {
    executionId,
    seconds: Math.round((Date.now() - began) / 1000),
    status,
    row: localWorkflowChangedEvent(final, address.conversationId),
    error: final.error,
    result: final.result?.markdown,
    attempts,
    replay: {
      sameResult: replayed.result?.markdown === final.result?.markdown,
      state: replayed.state,
      newAttempts: attemptsAfter.count - attempts.length
    }
  }
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    JSON.stringify({ state: final.state, error: final.error, report: join(out, 'report.json') })
  )
  database.close()
  process.exit(final.state === 'completed' ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
