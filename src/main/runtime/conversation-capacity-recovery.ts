import type { ConversationCapacityRecovery } from '../../shared/conversation-capacity-recovery'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { OrcaRuntimeService } from './omni-runtime'
import { isChainBoundToConversation } from './conversation-chain-ownership'
import {
  prepareCapacityRecovery,
  holdCapacityRecoveryPreparation
} from './conversation-capacity-recovery-prepare'
import { assignCapacityRecoveryTarget } from './conversation-capacity-account-selection'
export {
  capacityRecoveryAccountKey,
  selectCapacityRecoveryAccount
} from './conversation-capacity-account-selection'
export type { CapacityRecoveryCandidate } from './conversation-capacity-recovery-prepare'
const running = new WeakSet<OrcaRuntimeService>()
const terminalPhases = new Set(['held', 'cancelled', 'delivered'])

function current(runtime: OrcaRuntimeService, source: ConversationSource, id: string) {
  const queue = runtime.readPromptQueue(conversationSourceRowKey(source))
  return queue?.recovery?.id === id ? queue.recovery : null
}

function assertCurrent(runtime: OrcaRuntimeService, source: ConversationSource, id: string): void {
  const recovery = current(runtime, source, id)
  const queue = runtime.readPromptQueue(conversationSourceRowKey(source))
  if (
    !recovery ||
    terminalPhases.has(recovery.phase) ||
    runtime.isPtyStopRequested(recovery.sourcePtyId) ||
    runtime.hasConversationCapacityOwner(source) ||
    isChainBoundToConversation(runtime, source) ||
    queue?.entries.some((entry) => entry.state === 'queued' || entry.state === 'sending')
  ) {
    throw new Error('Capacity handoff was superseded by newer work or Stop.')
  }
}

function save(
  runtime: OrcaRuntimeService,
  source: ConversationSource,
  recovery: ConversationCapacityRecovery
) {
  runtime.saveConversationCapacityRecoveryAndFlush(source, recovery)
}

async function advance(
  runtime: OrcaRuntimeService,
  source: ConversationSource,
  recovery: ConversationCapacityRecovery
): Promise<void> {
  if (terminalPhases.has(recovery.phase)) {
    return
  }
  assertCurrent(runtime, source, recovery.id)
  if (recovery.phase !== 'created') {
    const supported = await runtime.supportsConversationCapacityRecovery()
    if (supported === null) {
      return
    }
    if (!supported) {
      throw new Error(
        'Automatic account handoff requires daemon support for durable session creation.'
      )
    }
    assertCurrent(runtime, source, recovery.id)
  }
  if (recovery.phase === 'waiting-capacity') {
    const assigned = assignCapacityRecoveryTarget(runtime, recovery)
    if (!assigned) {
      return
    }
    recovery = assigned
    save(runtime, source, recovery)
  }
  const target = recovery.target
  const successorIdentity = recovery.successor
  if (!target || !successorIdentity) {
    throw new Error('The saved handoff has no replacement identity.')
  }
  if (recovery.phase === 'prepared') {
    const stopped = await runtime.stopConversationCapacitySource(source, recovery)
    if (stopped === null) {
      return
    }
    if (!stopped) {
      throw new Error(
        'The interrupted agent could not be confirmed stopped. No replacement was started.'
      )
    }
    assertCurrent(runtime, source, recovery.id)
    recovery = {
      ...recovery,
      phase: 'stopped',
      reason: 'The previous executor stopped; starting the replacement.'
    }
    save(runtime, source, recovery)
  }
  if (recovery.phase === 'stopped') {
    const stopped = await runtime.stopConversationCapacitySource(source, recovery)
    if (stopped === null) {
      return
    }
    if (!stopped) {
      throw new Error('The previous execution state changed; replacement remains stopped.')
    }
    assertCurrent(runtime, source, recovery.id)
    if ((await runtime.supportsConversationCapacityRecovery()) !== true) {
      throw new Error(
        'Durable session creation became unavailable before starting the replacement.'
      )
    }
    assertCurrent(runtime, source, recovery.id)
    const provider = runtime.getLocalProvider()
    const successor = await runtime.createTerminal(`id:${source.worktreeId}`, {
      launchCause: {
        trigger: 'capacity-recovery',
        reference: { recoveryId: recovery.id },
        parentPaneKey: source.paneKey
      },
      startupAgent: target.agent,
      ...(target.model ? { launchPreferences: { model: target.model } } : {}),
      agentLaunchEnv: {
        [target.agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: target.accountHome
      },
      tabId: successorIdentity.tabId,
      leafId: successorIdentity.leafId,
      preAllocatedHandle: successorIdentity.handle,
      launchToken: successorIdentity.launchToken,
      agentSessionCreateOperationId: successorIdentity.operationId,
      viewMode: recovery.sourceViewMode,
      activate: false,
      surfaceOwner: false,
      beforeSpawn: () => {
        if (runtime.getLocalProvider() !== provider || provider?.routesFreshSpawnsToLocalProvider) {
          throw new Error('The durable terminal provider changed before replacement creation.')
        }
        assertCurrent(runtime, source, recovery.id)
      }
    })
    if (successor.paneKey !== `${successorIdentity.tabId}:${successorIdentity.leafId}`) {
      throw new Error('The replacement did not prove its saved conversation address.')
    }
    const retained = current(runtime, source, recovery.id)
    if (!retained) {
      throw new Error('The saved handoff disappeared while its replacement was starting.')
    }
    recovery = {
      ...retained,
      phase: retained.phase === 'stopped' ? 'created' : retained.phase,
      successor: {
        ...successorIdentity,
        source: { kind: 'pty', worktreeId: source.worktreeId, paneKey: successor.paneKey }
      },
      reason:
        retained.phase === 'stopped'
          ? 'The replacement is starting; the saved request will be delivered when it is ready.'
          : retained.reason
    }
    // Keep the new pane linked even when input cancelled recovery during its creation.
    save(runtime, source, recovery)
    assertCurrent(runtime, source, recovery.id)
  }
  if (recovery.phase === 'created' && recovery.successor?.source) {
    const target = runtime.readPromptQueue(conversationSourceRowKey(recovery.successor.source))
    const entry = target?.entries.find((entry) => entry.id === recovery.id)
    if (entry?.state === 'delivered') {
      save(runtime, source, {
        ...recovery,
        phase: 'delivered',
        reason: 'The replacement received the saved request and history.'
      })
    } else if (entry?.state === 'failed') {
      save(runtime, source, {
        ...recovery,
        phase: 'held',
        reason: entry.reason ?? 'Handoff delivery could not be confirmed.'
      })
    } else if (!entry) {
      if (target?.entries.some((entry) => entry.state === 'queued' || entry.state === 'sending')) {
        throw new Error('New instructions on the replacement superseded the automatic handoff.')
      }
      runtime.enqueuePromptQueueEntry(recovery.successor.source, {
        id: recovery.id,
        text: recovery.brief,
        createdAt: recovery.detectedAt,
        state: 'queued'
      })
      save(runtime, source, recovery)
    }
  }
}

/** One pass on the existing host tick. Native goals and healthy turns are never consulted or driven. */
export async function advanceConversationCapacityRecovery(
  runtime: OrcaRuntimeService,
  now = Date.now()
): Promise<void> {
  if (running.has(runtime)) {
    return
  }
  running.add(runtime)
  try {
    for (const candidate of runtime.listConversationCapacityFailures()) {
      await prepareCapacityRecovery(runtime, candidate, now).catch((error) => {
        console.warn('[capacity-recovery] preparation', error)
        holdCapacityRecoveryPreparation(runtime, candidate, now, error)
      })
    }
    for (const queue of Object.values(runtime.listPromptQueues())) {
      const recovery = queue.recovery
      if (!recovery || terminalPhases.has(recovery.phase)) {
        continue
      }
      try {
        await advance(runtime, queue.source, recovery)
      } catch (error) {
        const latest = current(runtime, queue.source, recovery.id)
        if (latest && !terminalPhases.has(latest.phase)) {
          save(runtime, queue.source, {
            ...latest,
            phase: 'held',
            reason:
              error instanceof Error
                ? error.message.slice(0, 2000)
                : 'Capacity handoff could not be confirmed.'
          })
        }
      }
    }
  } finally {
    running.delete(runtime)
  }
}
