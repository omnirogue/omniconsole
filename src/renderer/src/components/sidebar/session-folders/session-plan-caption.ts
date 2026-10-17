import { translate } from '@/i18n/i18n'
import type { SessionChainBlock } from '../../../../../shared/session-chain-types'

/** One line under a row whose plan is parked: who is waiting on the person, and what happens next. */
export function planNeedsYouCaption(block: SessionChainBlock, ownPane: boolean): string {
  if (block.reason === 'interrupted') {
    return ownPane
      ? translate(
          'nextStep.planInterrupted',
          'Interrupted · give it the next instruction and the plan carries on'
        )
      : translate(
          'nextStep.planStepInterrupted',
          'A step was interrupted · give it the next instruction and the plan carries on'
        )
  }
  return ownPane
    ? translate('nextStep.planNeedsAnswer', 'Needs your answer · the plan carries on after')
    : translate(
        'nextStep.planStepNeedsAnswer',
        'A step needs your answer · the plan carries on after'
      )
}
