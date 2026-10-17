import { createHash } from 'node:crypto'
import {
  captureSessionHandoff,
  sessionHandoffHostIo as hostIo,
  HandoffDeliverablesMissing
} from './session-handoff-capture'
import { deliverSessionFollowUp, FollowUpException } from '../../shared/session-follow-up-delivery'
import type { FollowUpHubIo } from '../../shared/session-follow-up-delivery-contract'
import type { SessionChain, SessionChainHandoffStep } from '../../shared/session-chain-types'
import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'
import type { HandoffRecipient } from '../../shared/console-handoff-contract'
import {
  decideSessionOutcomeHandoffRecovery,
  rekeyRefusedSessionOutcomeHandoff,
  SESSION_OUTCOME_HANDOFF_SIGN_IN,
  sessionOutcomeHandoffException,
  sessionOutcomeHandoffFailureReason
} from './session-outcome-handoff-recovery'

let transport: {
  hub: FollowUpHubIo
  principal(): Promise<string | null>
  recipients?(): Promise<HandoffRecipient[]>
  /** The pause between replays of one unconfirmed send; a test passes one that does not wait. */
  sleep?(ms: number): Promise<void>
} | null = null
export function installSessionOutcomeHandoffTransport(value: NonNullable<typeof transport>): void {
  transport = value
}
export async function readSessionOutcomePrincipal(): Promise<string | null> {
  return transport?.principal() ?? null
}

export async function readSessionOutcomeHandoffPeople(): Promise<{
  principal: string
  people: HandoffRecipient[]
}> {
  const active = transport
  if (!active?.recipients) {
    throw new Error('The signed-person recipient directory is unavailable on this host.')
  }
  const principal = await active.principal()
  if (!principal) {
    throw new Error('Sign in before choosing a person for this outcome.')
  }
  const people = await active.recipients()
  const currentPrincipal = await active.principal()
  if (transport !== active || currentPrincipal !== principal) {
    throw new Error(
      'The signed-in person changed while reading recipients. Read outcome context again.'
    )
  }
  return { principal, people }
}

/**
 * Whether a person handoff cannot even start here: this host has no signed-in transport, or the run
 * was committed without a signed person. Read without sending anything, so the status recompute can
 * keep saying so between passes instead of the sender finding it out again every tick.
 */
export function sessionOutcomeHandoffNeedsSignIn(chain: SessionChain): boolean {
  return !transport || !chain.outcomeSet?.continuation.principal
}

type HandoffExecution = {
  chain: SessionChain
  step: SessionChainHandoffStep
  summary: string
  read(): SessionChain
  save(chain: SessionChain): void
  now?: number
}

/**
 * Holds the outcome while a failed delivery is backing off, or is past what the host may retry by
 * itself. Once a bounded automatic resend is DUE it holds nothing, so the step runner sends again;
 * a person's `resume` clears the failure and starts a fresh series.
 */
export function sessionOutcomeHandoffBlocker(
  step: SessionChainHandoffStep,
  now = Date.now()
): string | undefined {
  const recovery = decideSessionOutcomeHandoffRecovery(step.handoff, now)
  return recovery.kind === 'wait' || recovery.kind === 'fail'
    ? sessionOutcomeHandoffFailureReason(step.handoff)
    : undefined
}

function saveHandoff(
  args: HandoffExecution,
  next: (handoff: SessionFollowUpRule) => SessionFollowUpRule
): void {
  const chain = args.read()
  // A sealed run is proven: a delivery that fails afterwards is never written back onto it.
  if (chain.outcomeSet?.completion) {
    return
  }
  args.save({
    ...chain,
    steps: chain.steps.map((step) =>
      step.id === args.step.id && step.kind === 'handoff'
        ? { ...step, handoff: next(step.handoff) }
        : step
    )
  })
}

/** Reuses the same manifests, pinned bytes, upload/version receipts and idempotency keys as renderer delivery. */
export async function executeSessionOutcomeHandoff(args: HandoffExecution): Promise<void> {
  const active = transport
  if (!active || sessionOutcomeHandoffNeedsSignIn(args.chain)) {
    throw new Error(SESSION_OUTCOME_HANDOFF_SIGN_IN)
  }
  const now = args.now ?? Date.now()
  const recovery = decideSessionOutcomeHandoffRecovery(args.step.handoff, now)
  if (recovery.kind === 'wait' || recovery.kind === 'fail') {
    throw new Error(sessionOutcomeHandoffFailureReason(args.step.handoff))
  }
  let step = args.step
  if (recovery.kind === 'resend' && recovery.rekey) {
    // Saved before anything leaves, like every other effect of a delivery. The failure stays on the
    // rule until this resend settles, so a crash in between cannot forget how many were spent.
    step = { ...step, handoff: rekeyRefusedSessionOutcomeHandoff(step.handoff) }
    saveHandoff(args, () => step.handoff)
  }
  try {
    await runSessionOutcomeHandoff(
      { ...args, step },
      active,
      args.chain.outcomeSet!.continuation.principal!
    )
  } catch (error) {
    // Why: the failure travels with the step, so later ticks read from it whether to wait, to send
    // again or to stop; files still missing are a wait, not a failure.
    if (!(error instanceof HandoffDeliverablesMissing)) {
      const exception = sessionOutcomeHandoffException({
        code: error instanceof FollowUpException ? error.code : 'unverifiable',
        subject: error instanceof FollowUpException ? error.subject : args.step.id,
        message: error instanceof Error ? error.message : String(error),
        resends: recovery.kind === 'resend' ? recovery.rung + 1 : 0,
        at: now
      })
      saveHandoff(args, (handoff) => ({ ...handoff, exception }))
    }
    throw error
  }
}

async function runSessionOutcomeHandoff(
  args: HandoffExecution,
  active: NonNullable<typeof transport>,
  principal: string
): Promise<void> {
  const checkIdentity = async (): Promise<void> => {
    if ((await active.principal()) !== principal) {
      throw new Error(
        'The signed company/person changed. Restore the original identity before continuing this handoff.'
      )
    }
  }
  await checkIdentity()
  let rule = args.step.handoff
  const save = async (next: SessionFollowUpRule): Promise<void> => {
    await checkIdentity()
    const chain = args.read()
    args.save({
      ...chain,
      steps: chain.steps.map((step) =>
        step.id === args.step.id && step.kind === 'handoff' ? { ...step, handoff: next } : step
      )
    })
    rule = next
  }
  if (!rule.capturedAt) {
    await save(await captureSessionHandoff(rule, args.chain.workspacePath, args.summary))
  }

  // Why each is behind the identity check: a re-ask on the same thread reads and writes as this person.
  const hub: FollowUpHubIo = {
    ...(active.hub.get
      ? {
          get: async (input) => {
            await checkIdentity()
            return active.hub.get!(input)
          }
        }
      : {}),
    ...(active.hub.returnFile
      ? {
          returnFile: async (input) => {
            await checkIdentity()
            return active.hub.returnFile!(input)
          }
        }
      : {}),
    ...(active.hub.respond
      ? {
          respond: async (input) => {
            await checkIdentity()
            return active.hub.respond!(input)
          }
        }
      : {}),
    ...(active.hub.agentRecipients
      ? {
          agentRecipients: async () => {
            await checkIdentity()
            return active.hub.agentRecipients!()
          }
        }
      : {}),
    ...(active.hub.sendAgent
      ? {
          sendAgent: async (input) => {
            await checkIdentity()
            return active.hub.sendAgent!(input)
          }
        }
      : {}),
    upload: async (...params) => {
      await checkIdentity()
      return active.hub.upload(...params)
    },
    send: async (...params) => {
      await checkIdentity()
      return active.hub.send(...params)
    },
    sendCardless: async (...params) => {
      await checkIdentity()
      return active.hub.sendCardless(...params)
    },
    uploadThreadFile: async (...params) => {
      await checkIdentity()
      return active.hub.uploadThreadFile(...params)
    },
    isRejected: active.hub.isRejected
  }
  const result = await deliverSessionFollowUp({
    current: () => rule,
    save,
    hub,
    bytes: async (pin) =>
      pin.generatedKind === 'transcript' && rule.transcriptFile
        ? (() => {
            const file = rule.transcriptFile!
            const bytes = Buffer.from(file.contentBase64, 'base64')
            return {
              ...file,
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex')
            }
          })()
        : pin.sourcePath
          ? hostIo.readExact(pin.sourcePath)
          : {
              name: pin.name,
              size: Buffer.byteLength(rule.summaryMarkdown ?? ''),
              sha256: createHash('sha256')
                .update(rule.summaryMarkdown ?? '')
                .digest('hex'),
              contentBase64: Buffer.from(rule.summaryMarkdown ?? '').toString('base64')
            },
    now: Date.now,
    sleep: active.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  })
  if (result !== 'delivered') {
    throw new Error('The handoff delivery stopped before all receipts were verified.')
  }
  const chain = args.read()
  args.save({
    ...chain,
    steps: chain.steps.map((step) => {
      if (step.id !== args.step.id || step.kind !== 'handoff') {
        return step
      }
      // Delivered: the failure an automatic resend recovered from is no longer true of this rule.
      const { exception: _recovered, ...handoff } = step.handoff
      return { ...step, status: 'delivered', handoff }
    })
  })
}
