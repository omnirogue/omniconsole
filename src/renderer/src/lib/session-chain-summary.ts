import { sessionOutcomeProgress } from '../../../shared/session-outcome-state'
import { translate } from '@/i18n/i18n'
import { sessionRunRowState } from './session-run-row-state'
import {
  isLiveSessionChain,
  type SessionChain,
  type SessionChainStep
} from '../../../shared/session-chain-types'

export type SessionChainSummary = {
  summary: string
  current: string | null
  placement: string | null
  handedTo: string | null
  ended: 'me' | 'done' | null
}

function stepLabel(step: SessionChainStep): string {
  return step.kind === 'handoff'
    ? step.handoff.recipients.map((recipient) => recipient.name).join(', ')
    : step.agent
}

export function describeSessionChain(chain: SessionChain, now = Date.now()): SessionChainSummary {
  // Why: paired versions may not yet publish these optional plan fields.
  const fields = chain as SessionChain & { end?: unknown; placement?: unknown }
  const ended = fields.end === 'done' || fields.end === 'me' ? fields.end : null
  const placement =
    typeof fields.placement === 'string' && fields.placement !== 'local' ? fields.placement : null
  if (chain.outcomeSet) {
    const run = sessionRunRowState(chain, { now })
    const progress = sessionOutcomeProgress(chain.outcomeSet, {
      now,
      planVersion: chain.planVersion
    })
    return {
      summary: translate(
        'nextStep.outcomesComplete',
        '{{satisfied}} of {{total}} outcomes complete',
        {
          satisfied: progress.satisfied,
          total: progress.total
        }
      ),
      // Why: a blocked reason is a diagnostic for Details. The lock says what the run is doing,
      // and a sealed, failed or cancelled run holds no lock line at all.
      current: run.settled || run.phase === 'active' ? null : run.headline,
      placement,
      handedTo: null,
      ended: run.phase === 'completed' ? 'done' : null
    }
  }
  const last = chain.steps.at(-1)
  // Why: a review comes back to whoever asked for it; only a handoff completes the conversation for me.
  const handedTo =
    chain.state === 'done' &&
    last?.kind === 'handoff' &&
    last.status === 'delivered' &&
    last.handoff.action !== 'review'
      ? last.handoff.recipients
          .filter((recipient) => recipient.delivery === 'sent')
          .map((recipient) => recipient.name)
          .join(', ') || null
      : null
  const labels = chain.steps.map(stepLabel)
  if (ended) {
    labels.push(
      ended === 'done'
        ? translate('nextStep.endSession', 'End session')
        : translate('conversations.planBackToMe', 'Back to me')
    )
  }
  const next = chain.steps[chain.currentIndex]
  const current = !isLiveSessionChain(chain)
    ? null
    : chain.state === 'ready'
      ? translate('conversations.planReady', 'Ready to start')
      : next
        ? translate('conversations.planNext', 'Next: {{step}}', { step: stepLabel(next) })
        : translate('conversations.planWaiting', 'Waiting for the current session')
  return { summary: labels.join(' → '), current, placement, handedTo, ended }
}
