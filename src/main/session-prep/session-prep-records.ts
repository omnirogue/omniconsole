import type { SessionPrepConnectorLaunch } from '../../shared/session-prep-connector'
import type { SessionPrepNativeReceipt } from './session-prep-connector-launch'
import type {
  GateVerdict,
  PlannedItem,
  PreparedFields,
  SessionPrepBatchState,
  SessionPrepBatchView,
  SessionPrepItemState,
  SessionPrepItemView,
  SessionPrepLaunchLabel,
  SessionPrepReuseChoice,
  SessionPrepReuseKind,
  SessionPrepSource
} from '../../shared/session-prep-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SessionPrepWorkspace } from './session-prep-host'
import type { SessionPrepItemRoute } from './session-prep-dispatch-route'

export const SESSION_PREP_MAX_STORED_BATCHES = 50
export const SESSION_PREP_LIST_RECENT_MS = 60_000

export const SESSION_PREP_TERMINAL_BATCH = new Set<SessionPrepBatchState>([
  'done',
  'cancelled',
  'failed'
])

export const SESSION_PREP_TERMINAL_ITEM = new Set<SessionPrepItemState>([
  'launched',
  'assigned',
  'already-covered',
  'failed',
  'cancelled'
])

export type SessionPrepItemLaunch = {
  kind: 'worktree' | 'session'
  name?: string
  operationId?: string
  startedAt: number
}

export type SessionPrepItemLaunched = {
  nativeReceipt?: SessionPrepNativeReceipt
  worktreeId: string
  newWorkspace: boolean
  at: number
  /** The created surface's owner key, retained so later batch items cannot offer it for reuse. */
  paneKey?: string
  /** Runtime handle is durable before waiting for the stable pane identity to arrive. */
  paneHandle?: string
  /** Distinguishes a normal launch awaiting identity from a crash-recovered unknown surface. */
  paneIdentity?: 'pending' | 'unresolved-launched' | 'unresolved-recovered'
}

export type SessionPrepReuseReservation = {
  index: number
  startedAt: number
  token: string
}

/** An existing session offered instead of launching (`session find-owner`). */
export type SessionPrepItemReuse = {
  /** It could take the task, is already doing it, or is busy editing its files. */
  kind: SessionPrepReuseKind
  /** Local past conversation; resumed only after the person chooses Assign. */
  ref?: string
  cwd?: string
  paneKey: string
  tabId: string | null
  title: string
  /** "idle, same folder" */
  why: string
  /** The person chose; `launch` launches as if no session had been offered. */
  decided?: SessionPrepReuseChoice
  /** Why giving it to that session did not work; the person may choose Launch new. */
  failed?: string
}

export type SessionPrepItemRecord = {
  index: number
  planned: PlannedItem
  state: SessionPrepItemState
  fields?: PreparedFields
  /** Set when preparation found the work in another registered repository. */
  targetRepoId?: string
  /** Frozen before preparation; later registration edits cannot redirect a launch. */
  executionTarget?: SessionPrepWorkspace
  verdicts: GateVerdict[]
  repairs: number
  prompt?: string
  /** Resolved project context for Assign; prompt stays unwrapped for a later Launch new. */
  reusePrompt?: string
  note?: string
  launch?: SessionPrepItemLaunch
  launched?: SessionPrepItemLaunched
  /** A verify gate is being bound to the launched session; resumed after a restart. */
  /** `exhausted`: automatic tries stopped; the obligation stays on record for a person to finish. */
  verifyPending?: { agent: TuiAgent; attempts?: number; exhausted?: boolean }
  /** The agent, model and effort it launched with. */
  launchedWith?: SessionPrepLaunchLabel
  /** The dispatch router's decision, kept for audit; absent when the person named model and effort. */
  route?: SessionPrepItemRoute
  /** The sidebar folder it was filed in (absent when filing failed or none was named). */
  filedIn?: string
  /** The agent template its brief carries, by display name. */
  agentTemplateName?: string
  reuse?: SessionPrepItemReuse
}

export type SessionPrepBatchRecord = {
  connectorLaunch?: SessionPrepConnectorLaunch
  /** Durable caller identity for a single independently submitted objective. */
  requestId?: string
  connectorOperator?: string
  connectorDigest?: string
  id: string
  createdAt: number
  updatedAt: number
  state: SessionPrepBatchState
  source: SessionPrepSource
  request: string
  context: string
  dropped: string[]
  items: SessionPrepItemRecord[]
  /** The agent template chosen where the batch was requested; absent means Default. */
  agentTemplateId?: string
  /** Existing project folder captured from the requesting conversation. */
  defaultFolder?: string
  /** The folder this batch's unnamed items are filed in, once created (see session-prep-batch-folder). */
  batchFolder?: { id: string; path: string }
  /** One serialized owner lookup; item offer/launch evidence is persisted before this clears. */
  reuseReservation?: SessionPrepReuseReservation
}

export type SessionPrepStoreFile = {
  version: 1
  batches: SessionPrepBatchRecord[]
}

/** Before launch: what the person chose (effort: or the preparer recommended); after: what it used. */
function launchView(
  item: SessionPrepItemRecord,
  sourceAgent: TuiAgent | undefined
): Pick<SessionPrepItemView, 'agent' | 'model' | 'effort' | 'folder' | 'host' | 'agentTemplate'> {
  const choices = item.planned.choices
  const settled = item.state === 'launched' || item.state === 'failed'
  const label = item.launchedWith ?? {
    agent: choices?.agent ?? sourceAgent,
    model: choices?.model,
    effort: choices?.effort ?? item.fields?.effort
  }
  const folder = item.filedIn ?? (settled ? undefined : choices?.folder)
  return {
    ...(label.agent ? { agent: label.agent } : {}),
    ...(label.model ? { model: label.model } : {}),
    ...(label.effort ? { effort: label.effort } : {}),
    ...(folder ? { folder } : {}),
    ...(choices?.host ? { host: choices.host } : {}),
    ...(item.agentTemplateName ? { agentTemplate: item.agentTemplateName } : {})
  }
}

export function toSessionPrepItemView(
  item: SessionPrepItemRecord,
  sourceAgent?: TuiAgent
): SessionPrepItemView {
  return {
    index: item.index,
    title: item.fields?.title ?? item.planned.title,
    state: item.state,
    direct: item.planned.direct,
    repairs: item.repairs,
    ...(item.route
      ? {
          routing:
            'unrouted' in item.route
              ? {
                  status: 'status' in item.route ? item.route.status : 'unavailable',
                  reason: item.route.unrouted,
                  ...('elapsedMs' in item.route ? { elapsedMs: item.route.elapsedMs } : {}),
                  ...('version' in item.route ? { version: item.route.version } : {})
                }
              : {
                  status: item.route.mode === 'shadow' ? 'shadow' : 'selected',
                  reason: item.route.reason,
                  tier: item.route.tier,
                  elapsedMs: item.route.elapsedMs,
                  version: item.route.version,
                  modelEvidence: item.route.modelEvidence,
                  selected: {
                    provider: item.route.provider,
                    model: item.route.model,
                    effort: item.route.effort
                  }
                }
        }
      : {}),
    ...(item.note ? { note: item.note } : {}),
    ...(item.launched
      ? {
          launched: {
            worktreeId: item.launched.worktreeId,
            newWorkspace: item.launched.newWorkspace
          }
        }
      : {}),
    ...launchView(item, sourceAgent),
    // Why not once decided: a chosen launch or an assign in flight offers nothing to click.
    ...(item.reuse &&
    ((item.state === 'awaiting-reuse' && !item.reuse.decided) ||
      item.state === 'assigned' ||
      item.state === 'already-covered')
      ? {
          reuse: {
            kind: item.reuse.kind,
            title: item.reuse.title,
            why: item.reuse.why,
            ...(item.reuse.failed ? { failed: item.reuse.failed } : {})
          }
        }
      : {})
  }
}

export function toSessionPrepBatchView(batch: SessionPrepBatchRecord): SessionPrepBatchView {
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    state: batch.state,
    source: batch.source,
    request: batch.request,
    items: batch.items.map((item) => toSessionPrepItemView(item, batch.source.agent)),
    notes: batch.dropped
  }
}

export function pruneSessionPrepBatches(
  batches: SessionPrepBatchRecord[]
): SessionPrepBatchRecord[] {
  if (batches.length <= SESSION_PREP_MAX_STORED_BATCHES) {
    return batches
  }
  const keep = new Set(batches.map((batch) => batch.id))
  const oldestFirst = [...batches].sort((left, right) => left.createdAt - right.createdAt)
  for (const batch of oldestFirst) {
    if (keep.size <= SESSION_PREP_MAX_STORED_BATCHES) {
      break
    }
    if (SESSION_PREP_TERMINAL_BATCH.has(batch.state)) {
      keep.delete(batch.id)
    }
  }
  return batches.filter((batch) => keep.has(batch.id))
}
