import type { SessionChain, SessionChainHandoffStep } from '../../shared/session-chain-types'
import type { OrchestrationShadowEmit } from './orchestration-shadow'
import type { OrchestrationShadowScan } from './orchestration-shadow-bounds'
import { shadowIdentity, shadowReference } from './orchestration-shadow-bounds'
import { countOrchestrationShadow as count } from './orchestration-shadow-measurement'

function handoffFacts(step: SessionChainHandoffStep, scan: OrchestrationShadowScan) {
  const people = scan.tail(step.handoff.recipients)
  const agents = scan.tail(step.handoff.agentRecipients)
  const complete = people.complete && agents.complete
  const recipients = [...people.values, ...agents.values]
  return {
    captured: step.handoff.capturedAt !== undefined,
    sent: complete ? recipients.filter((entry) => entry.delivery === 'sent').length : null,
    sending: complete ? recipients.filter((entry) => entry.delivery === 'sending').length : null,
    failed: complete ? recipients.filter((entry) => entry.delivery === 'failed').length : null,
    pending: complete ? recipients.filter((entry) => entry.delivery === 'pending').length : null,
    total: people.total + agents.total,
    receiptCount: complete
      ? people.values.filter((entry) => entry.threadId).length +
        agents.values.filter((entry) => entry.messageId).length
      : null,
    deliveryException: Boolean(step.handoff.exception),
    evidenceComplete: complete
  }
}

export function observeHandoffShadowChanges(
  previous: SessionChain,
  saved: SessionChain,
  emit: OrchestrationShadowEmit,
  scan: OrchestrationShadowScan
): void {
  const before = scan.tail(previous.steps),
    after = scan.tail(saved.steps)
  const prior = new Map(
    before.values.filter((step) => shadowIdentity(step.id)).map((step) => [step.id, step])
  )
  for (const [index, step] of after.values.entries()) {
    if (step.kind !== 'handoff' || !shadowIdentity(step.id)) {
      continue
    }
    const old = prior.get(step.id)
    if (!old && !before.complete && after.start + index < before.total) {
      count('ambiguousBaselineSkipped')
      continue
    }
    const facts = handoffFacts(step, scan)
    if (old?.kind === 'handoff' && old.status === step.status) {
      const priorFacts = handoffFacts(old, scan)
      if (
        (Object.keys(facts) as (keyof typeof facts)[]).every(
          (key) => priorFacts[key] === facts[key]
        )
      ) {
        continue
      }
    }
    emit({
      kind: 'handoff',
      reference: shadowReference(saved.id, step.id, step.handoff.revision),
      observed:
        step.status === 'delivered'
          ? 'delivered'
          : facts.deliveryException
            ? 'failed'
            : !facts.evidenceComplete
              ? 'unknown'
              : facts.failed
                ? 'failed'
                : facts.sending
                  ? 'sending'
                  : 'pending',
      choices: {
        delivered: 'Every requested delivery is backed by its recorded receipt.',
        failed: 'A delivery failed or has a recorded delivery exception.',
        sending: 'A delivery was attempted and still awaits its receipt.',
        pending: 'Delivery has not yet been receipted or attempted.',
        unknown:
          'Incomplete structural evidence cannot establish delivery; null counts are unknown.'
      },
      facts
    })
  }
}
