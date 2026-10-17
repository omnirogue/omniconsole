import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import { observeStructuredAgentSessionOutcome } from '../../../shared/structured-agent-session-outcome-observation'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { SessionOutcomeSourceContext } from '../../runtime/session-outcome-source-context'
import { resolveSessionOutcomeSourceActor } from '../../runtime/session-outcome-source-actor'
import { appendRecentPtyPathCandidates } from '../../runtime/terminal-output-path-candidates'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export function structuredSourceTurnContent(snapshot: AgentJournalSnapshot) {
  const latest = snapshot.submissions.at(-1)
  const user = snapshot.items.find((item) => item.itemId === latest?.providerItemId)
  const settled = snapshot.items.findLast(
    ({ body }) =>
      body.kind === 'status' &&
      body.turnLifecycle?.settlement?.providerItemId === latest?.providerItemId &&
      body.turnLifecycle?.settlement?.outcome === 'succeeded'
  )
  if (!user || !settled) {
    return null
  }
  const turn = snapshot.items.filter(
    (item) => item.sequence > user.sequence && item.sequence <= settled.sequence
  )
  const final = turn.findLast(
    ({ body }) =>
      body.kind === 'message' &&
      body.role === 'assistant' &&
      body.blocks.some((block) => block.type === 'text' && block.text.trim())
  )
  const summary =
    final?.body.kind === 'message'
      ? final.body.blocks
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n\n')
      : ''
  if (!summary.trim()) {
    return null
  }
  return {
    summary,
    files: [
      ...new Set([
        ...turn.flatMap(({ body }) => (body.kind === 'diff' ? [body.path] : [])),
        ...appendRecentPtyPathCandidates([], summary)
      ])
    ]
  }
}

export async function readStructuredSessionOutcomeSourceContext(
  context: {
    sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
    store: AgentSessionRecordStore
    adapter: StructuredAgentSessionAdapter
  },
  paneKey: string,
  workspaceId: string
): Promise<SessionOutcomeSourceContext | null> {
  const entries = [...context.sessions].filter(
    ([id, session]) =>
      session.params.location.workspaceId === workspaceId &&
      structuredAgentSessionPaneKey(structuredAgentSessionTabId(id), id) === paneKey
  )
  if (entries.length !== 1) {
    return null
  }
  const [sessionId, session] = entries[0]!
  const record = context.store.getRecord(sessionId)
  if (
    !record ||
    record.location.workspaceId !== workspaceId ||
    record.location.executionHostId !== 'local' ||
    record.location.wslDistro !== null ||
    record.lease.runtimeKind !== 'native' ||
    record.lease.claimStatus === 'conflicted' ||
    record.lease.claimStatus === 'reserved' ||
    record.lease.unreconciled ||
    record.lease.handoffStage ||
    record.lease.runtimeFence !== session.fence
  ) {
    return null
  }
  const snapshot = session.journal.snapshot()
  const fence = session.fence
  const latest = snapshot.submissions.at(-1)
  if (
    snapshot.sessionId !== sessionId ||
    !observeStructuredAgentSessionOutcome(snapshot).ready ||
    latest?.fence !== fence
  ) {
    return null
  }
  const content = structuredSourceTurnContent(snapshot)
  if (!content) {
    return null
  }
  const options = await context.adapter.readSourceOptions?.({
    sessionId,
    fence,
    clientMessageId: latest.clientMessageId
  })
  const actor = options
    ? resolveSessionOutcomeSourceActor({
        agent: record.provider,
        options: {
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {})
        }
      })
    : null
  const current = context.store.getRecord(sessionId)
  const after = session.journal.snapshot()
  if (
    !actor ||
    current?.lease.runtimeFence !== fence ||
    context.sessions.get(sessionId) !== session ||
    session.fence !== fence ||
    current.location.workspaceId !== workspaceId ||
    current.lease.runtimeKind !== 'native' ||
    current.lease.claimStatus === 'conflicted' ||
    current.lease.claimStatus === 'reserved' ||
    current.lease.unreconciled ||
    current.lease.handoffStage ||
    after.cursor.epoch !== snapshot.cursor.epoch ||
    after.cursor.sequence !== snapshot.cursor.sequence
  ) {
    return null
  }
  return {
    paneKey,
    handle: `agent-session:${sessionId}`,
    processIncarnation: `structured:${sessionId}`,
    ...actor,
    ...content
  }
}
