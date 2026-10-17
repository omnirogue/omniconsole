import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { SessionManageActor } from '../../shared/session-manage-types'
import { createTransferTarget, fileTransferTarget } from './session-transfer-lifecycle'
import { transferCheckpoints } from './session-transfer-checkpoints'
import { captureTransferExecution } from './session-transfer-execution'
import {
  readRuntimeLatestTurn,
  snapshotRuntimeLatestTurn,
  runtimeNeverReplied
} from './session-manage-runtime-sources'
import type { watchNewTransferTarget } from './session-transfer-new-target'
import { assertCreatedTransferSession } from './session-transfer-identity'
import type { RpcContext } from '../runtime/rpc/core'
import { SESSION_MANAGE_ASK_DEFAULT_TIMEOUT_MS } from '../runtime/rpc/methods/session-manage-schemas'
import type { SessionManageProvenance } from '../runtime/rpc/methods/session-manage-schemas'
import {
  prepareSessionAction,
  recordSessionAction
} from '../runtime/rpc/methods/session-manage-support'
import { queueQuestion } from './session-manage-ask'
import { runtimeTransferHostDeps } from './session-transfer-host-runtime'
import { runtimeTransferHostedDeps } from './session-transfer-runtime-hosted'
import { waitForAskReply } from './session-manage-ask-wait'
import { continueSession } from './session-manage-continue'
import { archiveTransferredSources } from './session-transfer-archive'
import {
  transferAcknowledgement,
  transferAcknowledgementInstruction
} from './session-transfer-acknowledgement'
import {
  runtimeAskWaitDeps,
  runtimeDeliveryDeps,
  showSessionManageNotice
} from './session-manage-runtime-actions'
import {
  transferBriefTag,
  type SessionTransferDeps,
  type TransferSession
} from './session-manage-transfer-contract'

const LAUNCH_WAIT_MS = 60_000

export function runtimeTransferDeps(
  context: RpcContext,
  actor: SessionManageActor,
  provenance: SessionManageProvenance,
  /** Adds the `--host` dependencies: a new target on another computer. */
  moving = false
): SessionTransferDeps {
  const { runtime } = context
  const created = new Map<
    string,
    { target: TransferSession; proof: ReturnType<typeof watchNewTransferTarget> }
  >()
  const baseDelivery = runtimeDeliveryDeps(runtime)
  const neverReplied = (source: Parameters<typeof baseDelivery.readLatestTurn>[0]) =>
    runtimeNeverReplied(runtime)(source) ||
    [...created.values()].some(({ proof }) => proof.neverReplied(runtime, source))
  const delivery = {
    ...baseDelivery,
    readLatestTurn: (source: Parameters<typeof baseDelivery.readLatestTurn>[0]) =>
      created.size
        ? readRuntimeLatestTurn(source, neverReplied)
        : baseDelivery.readLatestTurn(source),
    snapshotLatestTurn: (source: Parameters<typeof baseDelivery.snapshotLatestTurn>[0]) =>
      created.size
        ? snapshotRuntimeLatestTurn(source, neverReplied)
        : baseDelivery.snapshotLatestTurn(source)
  }
  const checkpoints = transferCheckpoints(
    (target) => delivery.snapshotLatestTurn(target.source!),
    (target) => captureTransferExecution(runtime, target)
  )
  const journal = async (
    action: 'session.create' | 'session.move',
    target: TransferSession,
    operation: unknown
  ) => {
    const warning = await recordSessionAction({
      actor,
      action,
      target: {
        paneKey: target.entry.paneKey,
        tabId: target.entry.tabId,
        title: target.entry.title
      },
      summary: `Preparing ${action}: operation recorded before dispatch.`,
      provenance,
      after: operation
    })
    if (warning) {
      throw new Error(`Nothing dispatched: ${warning}`)
    }
  }
  const wait = (target: TransferSession, entryId: string, marker: string, sent: string) => {
    if (!target.source) {
      throw new Error('The target has no verified conversation source.')
    }
    return waitForAskReply(runtimeAskWaitDeps(runtime, target.source, entryId), {
      rowKey: conversationSourceRowKey(target.source),
      marker,
      sentText: sent,
      timeoutMs: SESSION_MANAGE_ASK_DEFAULT_TIMEOUT_MS,
      requireCompleteReply: true,
      onCompleteReply: (turn) => checkpoints.capture(target, turn),
      signal: context.signal
    })
  }
  // Acceptance waits of targets started on another computer (`--host`).
  const launches: (() => void)[] = []
  const deps: SessionTransferDeps = {
    hosted: runtimeTransferHostedDeps(actor, context.signal),
    ...(moving
      ? {
          host: runtimeTransferHostDeps({
            context,
            journal,
            capture: (target, turn) => checkpoints.capture(target, turn),
            release: (stop) => launches.push(stop)
          })
        }
      : {}),
    signal: context.signal,
    assertCheckpoints: (targets) => checkpoints.assert(targets),
    refresh: async (target, waitForLaunch = false) => {
      const deadline = Date.now() + (waitForLaunch ? LAUNCH_WAIT_MS : 0)
      let failure = 'The new agent did not become live and idle in time.'
      for (;;) {
        if (context.signal?.aborted) {
          throw new Error('The caller stopped waiting.')
        }
        try {
          const prepared = await prepareSessionAction(
            context,
            target.entry.paneKey
              ? { paneKey: target.entry.paneKey }
              : { tabId: target.entry.tabId! }
          )
          if (
            !waitForLaunch ||
            (prepared.entry.verdict === 'live' &&
              ['idle', 'waiting-for-yes'].includes(prepared.entry.state) &&
              // Why: a prompt is only delivered once the new agent's own process holds the pane.
              (prepared.entry.kind !== 'terminal' ||
                (prepared.entry.agentForeground === true && prepared.agentProcess !== null)))
          ) {
            const birth = created.get(target.entry.terminal ?? '')
            if (birth) {
              assertCreatedTransferSession(birth.target, prepared)
              // Filing must use the provider key published after the verified fresh start.
              if (
                waitForLaunch &&
                (!prepared.row.providerSessionId ||
                  !prepared.source ||
                  !birth.proof.neverReplied(runtime, prepared.source))
              ) {
                throw new Error(
                  'The new target has not established its untouched fresh provider conversation.'
                )
              }
            }
            return prepared
          }
          failure = `“${prepared.entry.title}” is ${prepared.entry.state}: ${prepared.entry.waitingOn ?? prepared.entry.verdict}.`
        } catch (error) {
          if (!waitForLaunch) {
            throw error
          }
          failure = error instanceof Error ? error.message : String(error)
        }
        if (Date.now() >= deadline) {
          throw new Error(failure)
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    },
    // Both go through the core's delivery: exact pane, locality, agent-process binding, hard stops.
    ask: async (target, question) => {
      const queued = await queueQuestion(delivery, { actor, target, question, dryRun: false })
      const waiting = wait(target, queued.entryId!, queued.marker, queued.result.sent!)
      showSessionManageNotice(runtime, {
        kind: 'notice',
        summary: queued.result.summary,
        undo: { kind: 'dequeue', source: queued.source, entryId: queued.entryId! }
      })
      return { sent: queued.result.sent!, wait: waiting }
    },
    deliver: async (target, prompt) => {
      // Why a tag of its own: the acknowledgement is tied to this one brief, never another prompt.
      const id = delivery.newId()
      const tag = transferBriefTag(id)
      const acknowledgement = transferAcknowledgement(id)
      const queued = await continueSession(delivery, {
        actor,
        target,
        answer: {
          kind: 'prompt',
          text: `${prompt}\n\n${transferAcknowledgementInstruction(acknowledgement)}`
        },
        dryRun: false,
        transferId: id
      })
      const waiting = wait(target, queued.entryId!, tag, queued.result.sent!)
      showSessionManageNotice(runtime, {
        kind: 'notice',
        summary: queued.result.summary,
        undo: { kind: 'dequeue', source: target.source!, entryId: queued.entryId! }
      })
      return { sent: queued.result.sent!, wait: waiting, acknowledgement }
    },
    create: async (source, title) => {
      const birth = await createTransferTarget(runtime, source, title, journal)
      created.set(birth.target.entry.terminal!, birth)
      showSessionManageNotice(runtime, { kind: 'notice', summary: `Created “${title}”.` })
      return birth.target
    },
    file: (target, source) => fileTransferTarget(runtime, target, source, journal),
    dispose: () => {
      for (const stop of launches.splice(0)) {
        stop()
      }
      checkpoints.close()
      for (const { proof } of created.values()) {
        proof.close()
      }
      created.clear()
    },
    archive: (sources, reason, guard, target) =>
      archiveTransferredSources(runtime, sources, reason, guard, target),
    audit: (record) =>
      recordSessionAction({
        actor: record.actor,
        action: record.action,
        target: {
          paneKey: record.target.entry.paneKey,
          tabId: record.target.entry.tabId,
          title: record.target.entry.title
        },
        summary: record.summary,
        provenance: { ...provenance, ...(record.reason ? { reason: record.reason } : {}) },
        after: record.after
      })
  }
  return deps
}
