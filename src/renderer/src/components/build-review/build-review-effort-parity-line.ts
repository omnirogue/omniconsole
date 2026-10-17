import { translate } from '@/i18n/i18n'
import {
  isSessionEffortParityDivergent,
  sessionEffortParityValues,
  type SessionEffortParity
} from '../../../../shared/session-effort-parity'

/**
 * The one line a worker card adds when the worker did not start at what it was asked
 * for. Null when requested and reported agree, so a card that got what it asked for
 * stays exactly as it was.
 */
export function buildReviewEffortParityLine(
  parity: SessionEffortParity | null | undefined
): string | null {
  if (!parity || !isSessionEffortParityDivergent(parity)) {
    return null
  }
  const { requested = '', applied } = sessionEffortParityValues(parity)
  if (parity.state === 'unsupported') {
    return translate(
      'buildReview.effortUnsupported',
      'Asked for {{value0}}: this model does not advertise it, so it was not applied and nothing was lowered in its place.',
      { value0: requested }
    )
  }
  return applied
    ? translate('buildReview.effortMismatch', 'Asked for {{value0}} · started at {{value1}}', {
        value0: requested,
        value1: applied
      })
    : translate(
        'buildReview.effortNotApplied',
        'Asked for {{value0}} · started with no effort applied',
        { value0: requested }
      )
}
