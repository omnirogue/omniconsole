import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CAPACITY_RECOVERY_ENTRY_PREFIX,
  type ConversationCapacityRecovery
} from '../../shared/conversation-capacity-recovery'
import {
  conversationSourceRowKey,
  conversationSourcesEqual,
  type ConversationSource
} from '../../shared/conversation-source'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { readCompleteSessionTranscript } from '../transcripts/complete-session-transcript-reader'
import {
  buildCapacityRecoveryBrief,
  buildCapacityRecoveryTranscript
} from './capacity-recovery-brief'
import type { OrcaRuntimeService } from './omni-runtime'
import { isChainBoundToConversation } from './conversation-chain-ownership'
import { resolveCapacityRecoverySourceModel } from './conversation-capacity-source-model'

export type CapacityRecoveryCandidate = {
  source: ConversationSource
  handle: string
  ptyId: string
  processIncarnation: string
  agent: 'claude' | 'codex'
  providerSessionId: string
  transcriptPath: string
  childTranscriptPath?: string
  accountHome: string
  failedAt: number
  version: string
  failureReason: string
  model?: string
  viewMode?: 'terminal' | 'chat'
}

const startedAt = Date.now()

function previousHandoffs(
  runtime: OrcaRuntimeService,
  candidate: CapacityRecoveryCandidate
): ConversationCapacityRecovery[] {
  const parents: ConversationCapacityRecovery[] = []
  let source = candidate.source
  const visited = new Set<string>()
  const queues = Object.values(runtime.listPromptQueues())
  for (;;) {
    const parent = queues.find(
      (queue) =>
        queue.recovery?.successor?.source &&
        conversationSourcesEqual(queue.recovery.successor!.source!, source)
    )
    if (!parent?.recovery) {
      break
    }
    if (visited.has(parent.recovery.id) || parents.length >= 64) {
      throw new Error('The saved handoff history cannot be read safely.')
    }
    visited.add(parent.recovery.id)
    parents.unshift(parent.recovery)
    source = parent.source
  }
  return parents
}

async function sourceMessages(
  candidate: CapacityRecoveryCandidate,
  parents: readonly ConversationCapacityRecovery[]
): Promise<NativeChatMessage[]> {
  const messages: NativeChatMessage[] = []
  for (const parent of parents) {
    messages.push(
      ...(await readCompleteSessionTranscript({
        kind: 'provider',
        agent: parent.sourceAgent,
        sessionId: parent.sourceProviderSessionId,
        transcriptPath: parent.sourceTranscriptPath,
        expectedConnectionId: null
      }))
    )
  }
  messages.push(
    ...(await readCompleteSessionTranscript({
      kind: 'provider',
      agent: candidate.agent,
      sessionId: candidate.providerSessionId,
      transcriptPath: candidate.transcriptPath,
      expectedConnectionId: null
    }))
  )
  if (candidate.childTranscriptPath) {
    const childMessages = await readCompleteSessionTranscript({
      kind: 'provider',
      agent: 'claude',
      sessionId: candidate.providerSessionId,
      transcriptPath: candidate.childTranscriptPath,
      expectedConnectionId: null
    })
    // Child instructions are historical delegated work, never new human authority.
    messages.push(
      ...childMessages.map((message) => ({
        ...message,
        role: message.role === 'user' ? ('tool' as const) : message.role
      }))
    )
  }
  return messages
}

export async function prepareCapacityRecovery(
  runtime: OrcaRuntimeService,
  candidate: CapacityRecoveryCandidate,
  now: number
): Promise<void> {
  if (candidate.failedAt < startedAt || isChainBoundToConversation(runtime, candidate.source)) {
    return
  }
  const existing = runtime.readPromptQueue(conversationSourceRowKey(candidate.source))
  if (
    existing?.recovery?.sourceVersion === candidate.version ||
    existing?.entries.some((entry) => entry.state === 'queued' || entry.state === 'sending')
  ) {
    return
  }
  const snapshot = runtime.getAccountsSnapshot().rateLimits.accountCapacity
  if (!snapshot) {
    return
  }
  const model = await resolveCapacityRecoverySourceModel(candidate)
  const rows = [...snapshot.claude, ...snapshot.codex]
  const sourceAccount = rows.find(
    (row) =>
      row.provider === candidate.agent &&
      row.launchEnv?.[candidate.agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] ===
        candidate.accountHome
  )
  const sourceResetAt =
    sourceAccount?.limitedUntil ??
    [
      sourceAccount?.fiveHour,
      sourceAccount?.weekly,
      ...(/fable/i.test(model ?? '') ? [sourceAccount?.fableWeekly] : [])
    ]
      .filter((window) => window?.remainingPercent === 0 && window.resetsAt !== null)
      .reduce((at, window) => Math.max(at, window!.resetsAt!), 0)
  const parents = previousHandoffs(runtime, candidate)
  const attempted = parents.flatMap((parent) => parent.attemptAccounts)
  const attemptedAccounts = [
    ...new Set([...attempted, `${candidate.agent}:${candidate.accountHome}`])
  ]
  if (attemptedAccounts.length >= 64) {
    return
  }
  const messages = await sourceMessages(candidate, parents)
  const stillCurrent = runtime
    .listConversationCapacityFailures()
    .find(
      (entry) =>
        conversationSourcesEqual(entry.source, candidate.source) &&
        entry.version === candidate.version
    )
  if (!stillCurrent) {
    return
  }
  const workspacePath = await runtime.resolveConversationCapacityWorkspace(candidate.source)
  const id = `${CAPACITY_RECOVERY_ENTRY_PREFIX}${createHash('sha256').update(candidate.version).digest('hex')}`
  const artifactPath = join(
    getProfileUserDataPath(),
    'continuity-handoffs',
    `${id.slice(CAPACITY_RECOVERY_ENTRY_PREFIX.length)}.md`
  )
  const input = {
    agent: candidate.agent,
    providerSessionId: candidate.providerSessionId,
    workspacePath,
    messages,
    failureReason: candidate.failureReason,
    fullTranscriptPath: artifactPath
  }
  const transcript = buildCapacityRecoveryTranscript(input)
  const brief = buildCapacityRecoveryBrief(input)
  await mkdir(join(getProfileUserDataPath(), 'continuity-handoffs'), { recursive: true })
  await writeFile(artifactPath, transcript, { mode: 0o600 })
  // The failure identity is re-read after every preparatory await, before ownership moves.
  if (
    !runtime
      .listConversationCapacityFailures()
      .some((entry) => entry.version === candidate.version) ||
    isChainBoundToConversation(runtime, candidate.source) ||
    runtime
      .readPromptQueue(conversationSourceRowKey(candidate.source))
      ?.entries.some((entry) => entry.state === 'queued' || entry.state === 'sending')
  ) {
    return
  }
  runtime.saveConversationCapacityRecoveryAndFlush(candidate.source, {
    id,
    sourceVersion: candidate.version,
    sourceProcessIncarnation: candidate.processIncarnation,
    sourcePtyId: candidate.ptyId,
    sourceAgent: candidate.agent,
    ...(model ? { sourceModel: model } : {}),
    sourceProviderSessionId: candidate.providerSessionId,
    sourceTranscriptPath: candidate.transcriptPath,
    sourceAccountHome: candidate.accountHome,
    sourceWorkspacePath: workspacePath,
    sourceViewMode: candidate.viewMode,
    sourceFailedAt: candidate.failedAt,
    detectedAt: now,
    phase: 'waiting-capacity',
    ...(sourceResetAt ? { sourceResetAt } : {}),
    brief,
    historyPath: artifactPath,
    attemptAccounts: attemptedAccounts,
    reason: 'Waiting for an eligible account with capacity. OmniConsole will recheck automatically.'
  })
}

export function holdCapacityRecoveryPreparation(
  runtime: OrcaRuntimeService,
  candidate: CapacityRecoveryCandidate,
  now: number,
  error: unknown
): void {
  if (
    !runtime
      .listConversationCapacityFailures()
      .some((entry) => entry.version === candidate.version) ||
    runtime.readPromptQueue(conversationSourceRowKey(candidate.source))?.recovery
  ) {
    return
  }
  runtime.saveConversationCapacityRecoveryAndFlush(candidate.source, {
    id: `${CAPACITY_RECOVERY_ENTRY_PREFIX}${createHash('sha256').update(candidate.version).digest('hex')}`,
    sourceVersion: candidate.version,
    sourceProcessIncarnation: candidate.processIncarnation,
    sourcePtyId: candidate.ptyId,
    sourceAgent: candidate.agent,
    sourceProviderSessionId: candidate.providerSessionId,
    sourceTranscriptPath: candidate.transcriptPath,
    sourceAccountHome: candidate.accountHome,
    sourceFailedAt: candidate.failedAt,
    detectedAt: now,
    phase: 'held',
    brief:
      'The saved conversation remains available; its context could not be safely prepared for automatic handoff.',
    attemptAccounts: [`${candidate.agent}:${candidate.accountHome}`],
    reason:
      error instanceof Error
        ? error.message.slice(0, 2000)
        : 'The handoff context could not be captured.'
  })
}
