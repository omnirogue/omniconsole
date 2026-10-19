import type { SessionSidebarLensContext } from './session-sidebar-lens'
import { nestLivePlanSeats } from './session-sidebar-seat-state'
import type { RoutineSessionOwner } from './routine-backed-session'
import { isRoutineBackedSession } from './routine-backed-session'
import {
  conversationPlanLabel,
  conversationState,
  type ConversationState
} from './conversation-state'
import type {
  SessionSidebarBatchOrigin,
  SessionSidebarTreeRow
} from './session-sidebar-group-model'
import { isLiveSessionChain, type SessionChain } from '../../../shared/session-chain-types'
import type { WorkerLineageActionIdentity } from '../../../shared/worker-lineage'
import type { SessionChainRowInfo } from './session-chain-support'
import { classifyConversation } from './conversation-retention'
import { describeSessionChain } from './session-chain-summary'
import type { AgentPaneSnapshot } from '@/components/attention/agent-pane-snapshot'
import { isSessionSaved, type SessionFolderMetadata } from './session-folders'
import { agentSessionRowKeys } from './agent-session-note'
import { sessionRowFolderId } from './mirrored-conversation-folders'
import { isSessionGroupCollapsed, type SessionSidebarView } from './session-sidebar-view'
import { sessionWorkersKey } from './session-sidebar-worker-keys'
import { nestWorkerRows } from './session-sidebar-worker-rows'
import type { SidebarSession } from './sidebar-sessions'
import { cardsForSession, conversationDotStateForCard, dotStateForCard } from './session-pane-cards'
import { conversationViewKey } from './conversation-view'
import { sessionRunRowState } from './session-run-row-state'
import {
  passThroughSessionSidebarRowCache,
  type SessionSidebarRowCache
} from './session-sidebar-row-cache'
import {
  localWorkflowConversationState,
  localWorkflowDotState,
  localWorkflowNeedsYou,
  localWorkflowStatusUnverified
} from './local-workflow-tab-status'

export type PursuitSidebarTreeRow = SessionSidebarTreeRow & {
  pursuitChain?: SessionChain
  pursuitState?: ConversationState
  pursuitLabel?: string
  children?: PursuitSidebarTreeRow[]
  childrenCollapsed?: boolean
}

export type SessionSidebarTreeInput = {
  /** Defaults to the current clock; passed in so retention can be tested at a fixed time. */
  routineOwners?: readonly RoutineSessionOwner[]
  now?: number
  showArchived?: boolean
  chainsByRowKey?: ReadonlyMap<string, SessionChainRowInfo>
  chainByRowKey?: ReadonlyMap<string, SessionChain>
  retainedStartedAtByPaneKey?: ReadonlyMap<string, number>
  /** Panes a plan handed back (key → ms), from the per-device wait-later marks. */
  returnedByPaneKey?: ReadonlyMap<string, number>
  /** When this device first saw each row, for rows whose own time is unknown. */
  firstSeenByRowKey?: ReadonlyMap<string, number>
  sessions: readonly SidebarSession[]
  waitingUntilByPaneKey?: ReadonlyMap<string, string>
  waitingUntilByRowKey?: Readonly<Record<string, string>>
  metadata: SessionFolderMetadata
  view: SessionSidebarView
  /** View keys the person archived by hand. */
  archivedKeys?: ReadonlySet<string>
  snapshot: Pick<AgentPaneSnapshot, 'cardsByPaneKey' | 'cardsByTabId' | 'attentionByPaneKey'>
  query: string
  /** Extra searchable text for a row, such as the title of the task it serves. */
  searchText?: (session: SidebarSession) => string | null | undefined
  showHidden: boolean
  /** Reuses each row's classification across rebuilds; without one, every build reclassifies all. */
  rowCache?: SessionSidebarRowCache
  /** Batch folders by folder id (session-batch-origins); every other folder is the person's. */
  batchOrigins?: Readonly<Record<string, SessionSidebarBatchOrigin>>
  /** Panes the session steward lists as Stalled (`sessionSteward.status`). */
  stalledPaneKeys?: ReadonlySet<string>
  /** What the Group-by views read beyond the rows (session-sidebar-lens). */
  lensContext?: SessionSidebarLensContext
  /** Worker pane leaf → the leaf of the pane that dispatched it (use-worker-lineage). */
  workerParentByLeaf?: ReadonlyMap<string, string>
  workerDispatchByLeaf?: ReadonlyMap<string, WorkerLineageActionIdentity>
  workerSubagentLeaves?: ReadonlySet<string>
}

/**
 * One row per session, with the group each belongs to. Every row's classification goes through
 * the cache, so a status ping or a minute tick reclassifies only the rows whose own inputs moved.
 */
export function buildSessionSidebarTreeRows(
  input: SessionSidebarTreeInput,
  now: number
): {
  rows: PursuitSidebarTreeRow[]
  classifications: Map<string, string>
  workersByRowKey: Map<string, PursuitSidebarTreeRow[]>
  /** Agent sessions: workers whose launcher is not listed, and sessions an agent launched. */
  agentRowKeys: ReadonlySet<string>
} {
  const rows: PursuitSidebarTreeRow[] = []
  const classifications = new Map<string, string>()
  const cache = input.rowCache ?? passThroughSessionSidebarRowCache()
  cache.beginBuild()
  for (const session of input.sessions) {
    if (isRoutineBackedSession(session, input.routineOwners ?? [])) {
      continue
    }
    const { card, attention: listed } = cardsForSession(session, input.snapshot)
    // Why: a run's request is read from the run on the row that owns it; listed again on a
    // worker's row it would be counted twice.
    const attention = listed?.run ? null : listed
    const viewKey = conversationViewKey(session)
    const legacyUntil = input.view.snoozedUntil?.[viewKey] ?? 0
    const waitingUntil =
      (session.paneKey ? input.waitingUntilByPaneKey?.get(session.paneKey) : null) ??
      input.waitingUntilByRowKey?.[`conversation:${viewKey}`] ??
      (legacyUntil > now ? new Date(legacyUntil).toISOString() : null)
    const chain = input.chainByRowKey?.get(session.rowKey)
    const chainState = input.chainsByRowKey?.get(session.rowKey)?.state
    // Why: a cancelled plan gives the conversation back; it is classified as the conversation it is.
    const plan = chain?.outcomeSet && chain.state !== 'cancelled' ? chain : undefined
    const snoozed = waitingUntil !== null
    const planRun = plan ? sessionRunRowState(plan, { now, snoozed }) : null
    const asks = planRun?.requests.length ?? 0
    // Why: acknowledging a finished pane greys its dot, but the work is still finished. A
    // workflow tab has no pane: its state is the host's pushed run state.
    const state = session.workflow
      ? localWorkflowDotState(session.workflow.status)
      : chainState === 'failed' || chain?.state === 'failed'
        ? 'failed'
        : conversationDotStateForCard(card)
    const working = session.workflow ? state === 'working' : dotStateForCard(card) === 'working'
    const needsAttention = attention !== null || localWorkflowNeedsYou(session.workflow)
    const returnedAt = session.paneKey ? input.returnedByPaneKey?.get(session.paneKey) : undefined
    const finishAction = input.metadata.finishActions?.[viewKey]
    const retainedStartedAt = input.retainedStartedAtByPaneKey?.get(
      card?.paneKey ?? session.paneKey ?? ''
    )
    const firstSeenAt = input.firstSeenByRowKey?.get(session.rowKey)
    const stalled = Boolean(session.paneKey && input.stalledPaneKeys?.has(session.paneKey))
    const archivedByKey =
      session.ownerArchive?.archived ?? input.archivedKeys?.has(viewKey) === true
    const archivedByView = session.ownerArchive
      ? false
      : input.view.archived?.includes(viewKey) === true
    // Why (C3): an owner-vouched row is filed where its owner filed it, else as filed here.
    const folderId = sessionRowFolderId(input.metadata, session, viewKey)
    // Why: a saved row is put away; a live question, or a run's open request, takes it back out.
    // Archiving by hand beats both: the row leaves its folder for Archived, and unarchiving
    // brings it back, since archiving never touches folder membership.
    const saved =
      !archivedByKey &&
      !archivedByView &&
      isSessionSaved(input.metadata, viewKey) &&
      !working &&
      !card?.activityUnverifiable &&
      !(session.launchPending && session.workflow?.status !== 'draft') &&
      !localWorkflowStatusUnverified(session.workflow?.status) &&
      card?.bucket !== 'working' &&
      !planRun?.running &&
      (plan ? asks === 0 : !needsAttention)
    // Only pending deadlines and plan transitions need the clock in their cache key.
    const clockSensitive =
      waitingUntil !== null ||
      legacyUntil > 0 ||
      chain !== undefined ||
      finishAction !== undefined ||
      retainedStartedAt !== undefined ||
      archivedByKey ||
      archivedByView
    const { row, classification } = cache.resolve(
      session.rowKey,
      [
        session,
        card,
        attention,
        waitingUntil,
        chain,
        chainState,
        state,
        returnedAt,
        finishAction,
        retainedStartedAt,
        firstSeenAt,
        archivedByKey,
        archivedByView,
        folderId,
        saved,
        stalled,
        clockSensitive ? now : 0
      ],
      () => {
        // Why: a mark older than the pane's last state change belongs to work that has moved on.
        const returned = returnedAt !== undefined && returnedAt >= (card?.stateChangedAt ?? 0)
        const classified = classifyConversation({
          canonicalBucket: card?.bucket,
          launchPending: session.launchPending,
          finishedAt:
            finishAction?.action === 'me' && finishAction.applied
              ? finishAction.completedAt
              : undefined,
          now,
          state,
          returned,
          stateChangedAt: card?.stateChangedAt,
          retainedStartedAt,
          waitingUntil,
          // A workflow paused, awaiting recovery or asked a question waits on the person: Needs you.
          attention: needsAttention,
          stalled,
          firstSeenAt,
          // Why: a run still being read, not found or unreadable is kept in view, never finished.
          unavailable:
            session.unavailable ||
            card?.activityUnverifiable === true ||
            localWorkflowStatusUnverified(session.workflow?.status),
          chain,
          archived: archivedByKey || archivedByView,
          working
        })
        const activityUnverifiable =
          card?.activityUnverifiable ||
          (state === null &&
            !waitingUntil &&
            !session.workflow &&
            !session.launchPending &&
            (!chain || !isLiveSessionChain(chain)) &&
            classified.group === 'waiting')
        const archived = !saved && (archivedByView || classified.group === 'archived')
        const run = plan ? sessionRunRowState(plan, { now, archived, saved, snoozed }) : null
        // Why: a run in progress holds its row; a settled or asking one holds nothing.
        const live =
          chain &&
          isLiveSessionChain(chain) &&
          (run
            ? !run.settled && run.requests.length === 0 && !archived
            : classified.group === 'waiting')
        // Why: a plan's panes never ask on their own. What is left is the conversation's own
        // question: before the run owns its source, or fresh after the run finished.
        const paneAsks = run ? classified.group === 'attention' && asks === 0 : true
        // Why: a workflow never started is the person's draft, not work waiting on anything.
        const draft = session.workflow?.status === 'draft' && classified.group === 'waiting'
        const classification = saved
          ? 'saved'
          : archivedByView
            ? 'archived'
            : draft
              ? 'drafts'
              : classified.group
        const visualState = session.workflow
          ? localWorkflowConversationState(session.workflow.status)
          : !['completed', 'stopped'].includes(classification) &&
              (activityUnverifiable || session.unavailable)
            ? 'unverifiable'
            : classification === 'conversations'
              ? run?.running
                ? 'running'
                : 'working'
              : classification === 'completed'
                ? !plan && (state === 'idle' || state === null)
                  ? 'inactive'
                  : 'done'
                : classification === 'stopped'
                  ? state === 'interrupted'
                    ? 'interrupted'
                    : 'failed'
                  : classification === 'attention'
                    ? 'needs-you'
                    : classification === 'waiting' && run?.phase === 'completed'
                      ? 'awaiting'
                      : session.launchPending
                        ? 'queued'
                        : conversationState({
                            chain: plan,
                            state,
                            waiting: snoozed,
                            needsYou: false,
                            now
                          })
        return {
          classification,
          row: {
            pursuitState: visualState as ConversationState,
            locked: live ? describeSessionChain(chain, now) : null,
            returned: !run && returned && classified.group === 'attention',
            planNeedsYou: run
              ? run.countsAsAttention
              : classified.group === 'attention' && !returned && attention === null,
            completed: classified.completed,
            archived,
            session,
            folderId,
            // Why: a waiting session is not "needs you" until its time; it sits under Waiting.
            attention: classified.group === 'attention' && paneAsks ? attention : null,
            activityUnverifiable,
            unreadCompletion: card?.unreadCompletion,
            state,
            backgroundTaskCount: state === 'monitoring' ? card?.backgroundTaskCount : undefined,
            waitingUntil,
            ...(run ? { run } : {})
          }
        }
      }
    )
    classifications.set(session.rowKey, classification)
    // Why a fresh object: seats are attached to a plan row below, and a cached row is shared.
    rows.push(
      plan
        ? {
            ...row,
            pursuitChain: plan,
            pursuitLabel: conversationPlanLabel(plan)
          }
        : row
    )
  }
  cache.retain(new Set(input.sessions.map((session) => session.rowKey)))
  const children = nestLivePlanSeats(rows, input.chainByRowKey)
  const nested = nestWorkerRows(
    rows.filter((row) => !children.has(row.session.rowKey)),
    {
      workerParentByLeaf: input.workerParentByLeaf,
      workerDispatchByLeaf: input.workerDispatchByLeaf,
      workerSubagentLeaves: input.workerSubagentLeaves,
      chainByRowKey: input.chainByRowKey,
      isExpanded: (row) =>
        !isSessionGroupCollapsed(input.view, sessionWorkersKey(conversationViewKey(row.session)))
    }
  )
  const { orphanRowKeys, ...listed } = nested
  const agentRowKeys = agentSessionRowKeys(listed, orphanRowKeys, input.metadata)
  return { ...listed, agentRowKeys, classifications }
}
