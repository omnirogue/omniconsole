import type { GlobalSettings } from '../../shared/global-settings-types'
import { failure } from './console-workflow-transport'
import { cardlessHandoffsEnabledByPreference } from '../../shared/cardless-handoff-preference'

/** The verbs a handoff without a card needs; profiles may explicitly opt out. */
export const CARDLESS_HANDOFF_VERBS = ['sendCardless', 'uploadThreadFile', 'bindThread'] as const

/** Null when card-less handoffs are on; else the refusal every gated verb answers with. */
export function cardlessHandoffsRefusal(
  settings: Pick<GlobalSettings, 'experimentalCardlessHandoffs'> | null | undefined
): ReturnType<typeof failure> | null {
  return cardlessHandoffsEnabledByPreference(settings)
    ? null
    : failure(
        'cardless_handoffs_disabled',
        'A handoff without a task card is off. Turn on card-less handoffs under Settings → Experimental.'
      )
}
