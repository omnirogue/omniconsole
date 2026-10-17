import { timingSafeEqual } from 'node:crypto'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { observeStructuredAgentSessionOutcome } from '../../../shared/structured-agent-session-outcome-observation'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { readStructuredSessionOutcomeSourceContext } from './structured-agent-session-source-context'

export type StructuredSessionOutcomeAuthority = {
  sessionId: string
  handle: string
  paneKey: string
  worktreeId: string
  prompt: string
  clientMessageId: string
  fence: number
}

export function createStructuredSessionOutcomeAccess(
  context: () => {
    sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
    store: AgentSessionRecordStore
    adapter?: StructuredAgentSessionAdapter
    now: number
  }
) {
  return {
    authorize: (evidence: OrchestrationCompatibilityEvidence | undefined) => {
      const { sessions, store, now } = context()
      return authorizeStructuredSessionOutcomeSource(sessions, store, evidence, now)
    },
    observe: (paneKey: string, workspaceId: string) => {
      const { sessions, store } = context()
      return observeStructuredSessionOutcomeSource(sessions, store, paneKey, workspaceId)
    },
    transferOwnership: (paneKey: string, workspaceId: string): string | null => {
      const { sessions, store, now } = context()
      const entry = [...sessions].find(
        ([id, session]) =>
          session.params.location.workspaceId === workspaceId &&
          structuredAgentSessionPaneKey(structuredAgentSessionTabId(id), id) === paneKey
      )
      if (!entry) {
        return null
      }
      const [id, session] = entry
      const record = store.getRecord(id)
      const lease = record?.lease
      if (
        !record ||
        !lease ||
        record.location.executionHostId !== 'local' ||
        record.location.workspaceId !== workspaceId ||
        record.location.wslDistro !== null ||
        !session.hasProviderChild ||
        lease.runtimeKind !== 'native' ||
        lease.claimStatus !== 'live' ||
        lease.unreconciled ||
        lease.handoffStage !== null ||
        lease.deathEvidence !== null ||
        lease.leaseDeadlineAt <= now ||
        lease.runtimeFence !== session.fence ||
        !lease.ownerProcess ||
        lease.ownerProcess.hostId !== 'local'
      ) {
        return null
      }
      const observed = observeStructuredAgentSessionOutcome(session.journal.snapshot())
      return observed.ready && observed.version
        ? JSON.stringify([id, lease.runtimeFence, observed.version])
        : null
    },
    hasBackgroundWork: (paneKey: string, workspaceId: string) => {
      const { sessions, adapter } = context()
      return [...sessions].some(
        ([id, session]) =>
          session.params.location.workspaceId === workspaceId &&
          structuredAgentSessionPaneKey(structuredAgentSessionTabId(id), id) === paneKey &&
          adapter?.backgroundTaskState?.(id)?.state === 'monitoring'
      )
    },
    context: (paneKey: string, workspaceId: string) => {
      const source = context()
      return source.adapter
        ? readStructuredSessionOutcomeSourceContext(
            { ...source, adapter: source.adapter },
            paneKey,
            workspaceId
          )
        : Promise.resolve(null)
    }
  }
}

export function authorizeStructuredSessionOutcomeSource(
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>,
  store: AgentSessionRecordStore,
  evidence: OrchestrationCompatibilityEvidence | undefined,
  now: number
) {
  const sessionId = evidence?.agentSessionId
  return structuredSessionOutcomeAuthority({
    evidence,
    record: sessionId ? store.getRecord(sessionId) : null,
    session: sessionId ? sessions.get(sessionId) : undefined,
    now
  })
}

export function observeStructuredSessionOutcomeSource(
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>,
  store: AgentSessionRecordStore,
  paneKey: string,
  workspaceId: string
) {
  const entry = [...sessions].find(
    ([id, session]) =>
      session.params.location.workspaceId === workspaceId &&
      structuredAgentSessionPaneKey(structuredAgentSessionTabId(id), id) === paneKey
  )
  if (!entry) {
    return null
  }
  const record = store.getRecord(entry[0])
  if (
    !record ||
    record.location.executionHostId !== 'local' ||
    record.location.wslDistro !== null ||
    record.lease.runtimeKind !== 'native' ||
    record.lease.unreconciled ||
    record.lease.handoffStage
  ) {
    return { ready: false, unverifiable: true, reason: 'Native source ownership is unverifiable.' }
  }
  return observeStructuredAgentSessionOutcome(entry[1].journal.snapshot())
}

export function structuredSessionOutcomeAuthority(input: {
  evidence: OrchestrationCompatibilityEvidence | undefined
  record: AgentSessionRecord | null
  session: StructuredAgentSessionHostSession | undefined
  now: number
}): StructuredSessionOutcomeAuthority | null {
  const { evidence, record, session, now } = input
  if (!record || !session || !evidence?.agentSessionId || evidence.host) {
    return null
  }
  const { lease, location } = record
  const token = evidence.launchToken
  const owner = lease.ownerProcess
  if (
    record.sessionId !== evidence.agentSessionId ||
    location.executionHostId !== 'local' ||
    location.wslDistro !== null ||
    session.params.location.workspaceId !== location.workspaceId ||
    !session.hasProviderChild ||
    lease.runtimeKind !== 'native' ||
    lease.claimStatus !== 'live' ||
    lease.unreconciled ||
    lease.handoffStage !== null ||
    lease.deathEvidence !== null ||
    lease.leaseDeadlineAt <= now ||
    lease.runtimeFence !== session.fence ||
    !owner ||
    owner.hostId !== location.executionHostId ||
    typeof token !== 'string' ||
    !token ||
    token.length > 4_096 ||
    !sameSecret(token, owner.spawnToken)
  ) {
    return null
  }
  const paneKey = structuredAgentSessionPaneKey(
    structuredAgentSessionTabId(record.sessionId),
    record.sessionId
  )
  if (evidence.paneKey !== paneKey || evidence.terminalHandle) {
    return null
  }
  // Only admitted sends carry sourcePrompt; provider echoes never author this field.
  const submission = session.journal.submissions().at(-1)
  if (
    !submission ||
    submission.fence !== lease.runtimeFence ||
    (submission.dispatchState !== 'pending' && submission.dispatchState !== 'accepted') ||
    !submission.sourcePrompt?.trim() ||
    submission.sourcePrompt.length > 256_000
  ) {
    return null
  }
  return {
    sessionId: record.sessionId,
    handle: `agent-session:${record.sessionId}`,
    paneKey,
    worktreeId: location.workspaceId,
    prompt: submission.sourcePrompt,
    clientMessageId: submission.clientMessageId,
    fence: lease.runtimeFence
  }
}

function sameSecret(left: string, right: string): boolean {
  const actual = Buffer.from(left)
  const expected = Buffer.from(right)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
