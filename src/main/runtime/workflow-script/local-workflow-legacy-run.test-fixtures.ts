import { lstat, realpath } from 'node:fs/promises'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import type { LocalWorkflowStartRequest } from '../../../shared/local-workflow-rpc'
import { resolveLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { hostCatalog, type hostFixture } from './local-workflow-host.test-fixtures'
import { prepareLocalWorkflowOutput } from './local-workflow-output'
import { DISCOVER_V7_RULES } from './presets/discover-v7-config'
import { WorkflowCheckpointStore, workflowEvidenceDigest } from './workflow-checkpoint-store'
import { COUNCIL_REVISION, DISCOVER_REVISION } from './workflow-program-revisions'

type HostFixture = Awaited<ReturnType<typeof hostFixture>>

/** A seat-based draft as an earlier build started it: three seats, Claude chairs, no graph. */
export function legacyRequest(
  preset: 'council' | 'discover' = 'council',
  worktree = 'workspace-a',
  conversationId = 'conversation-a'
): LocalWorkflowStartRequest {
  const draft = createLocalWorkflowDraft(preset, preset === 'council' ? 'Question' : 'Find bugs')
  draft.concurrency = 2
  draft.seats = hostCatalog.map(({ agent, accountId }, index) => ({
    id: `seat-${index + 1}`,
    agent,
    accountId
  }))
  draft.synthesizerId = 'seat-1'
  if (preset === 'council') {
    draft.council = { memberIds: draft.seats.map((seat) => seat.id) }
  } else {
    draft.discover.finderIds = ['seat-1', 'seat-2']
    // Discover's call limit is its agent ceiling; a small ceiling keeps the fixture run short.
    draft.discover.maxAgents = 20
  }
  return { worktree, conversationId, requestId: 'request-1', preset, draft }
}

/** The row seat-based admission wrote, snapshot shape exact, left paused as a restart leaves it. */
export async function seedLegacyWorkflowRun(
  f: HostFixture,
  request: LocalWorkflowStartRequest = legacyRequest(),
  state: 'paused' | 'running' = 'paused'
) {
  const { draft, preset } = request
  const root = await realpath(f.path)
  const info = await lstat(root, { bigint: true })
  const workspaceRoot =
    draft.access === 'frozen'
      ? undefined
      : { path: root, device: String(info.dev), inode: String(info.ino) }
  const output = draft.outputFileName
    ? await prepareLocalWorkflowOutput(root, draft.outputFileName)
    : undefined
  const snapshot: LocalWorkflowHostSnapshot = {
    version: 1,
    capability: { mode: 'frozen-analysis', revision: 1 },
    ...(preset === 'council'
      ? { councilProgramRevision: COUNCIL_REVISION }
      : { discoverProgramRevision: DISCOVER_REVISION }),
    ...(workspaceRoot ? { access: 'workspace-read' as const } : {}),
    limits: { concurrency: draft.concurrency },
    task: { prompt: draft.prompt.trim(), evidence: '' },
    seats: draft.seats.map((seat) => resolveLocalWorkflowSeat(seat, hostCatalog)),
    synthesizerId: draft.synthesizerId,
    ...(preset === 'council' && draft.council
      ? { council: { memberIds: [...draft.council.memberIds] } }
      : {}),
    discover: draft.discover,
    host: {
      workspaceId: request.worktree,
      conversationId: request.conversationId,
      requestDigest: workflowEvidenceDigest(JSON.stringify({ preset, draft })),
      startedAt: Date.now(),
      concurrency: draft.concurrency,
      sources: [],
      coverage: [],
      ...(output ? { output } : {}),
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(preset === 'discover' ? { discoverRules: DISCOVER_V7_RULES } : {})
    }
  }
  const callLimit =
    preset === 'council'
      ? (draft.council?.memberIds.length ?? 0) * 2 + 1
      : (draft.discover.maxAgents ?? 20)
  const executionId = new WorkflowCheckpointStore(f.db.db).create({
    conversationId: JSON.stringify([request.worktree, request.conversationId]),
    requestId: request.requestId,
    owner: f.owner,
    preset,
    snapshot,
    fence: 1,
    attemptLimit: draft.attemptLimit,
    callLimit,
    budgetLimit: callLimit * draft.attemptLimit
  })
  f.db.db.prepare('UPDATE local_workflow_executions SET state=? WHERE id=?').run(state, executionId)
  const address = {
    worktree: request.worktree,
    conversationId: request.conversationId,
    executionId
  }
  return { executionId, address, request }
}

/** Resumed through the host, as a person does, so the host runs the frozen program. */
export async function resumeLegacyWorkflowRun(
  f: HostFixture,
  request: LocalWorkflowStartRequest = legacyRequest()
) {
  const seeded = await seedLegacyWorkflowRun(f, request)
  const { fence } = await f.host.show(seeded.address)
  await f.host.control({ ...seeded.address, fence, action: 'resume' })
  return seeded
}
