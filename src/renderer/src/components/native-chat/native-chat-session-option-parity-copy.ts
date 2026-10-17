import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import {
  sessionEffortParityValues,
  type SessionEffortParity
} from '../../../../shared/session-effort-parity'
import { translate } from '@/i18n/i18n'
import { nativeChatSessionChoiceLabel } from './native-chat-session-option-labels'

/** The label a value would carry in the picker, so a mismatch reads like the menu. */
function parityValueLabel(descriptor: SessionOptionDescriptor, value: string): string {
  const choice =
    descriptor.kind.type === 'select'
      ? descriptor.kind.choices.find((candidate) => candidate.value === value)
      : undefined
  return nativeChatSessionChoiceLabel(choice ?? { value, label: value })
}

function requestedValue(parity: SessionEffortParity): string | undefined {
  return sessionEffortParityValues(parity).requested
}

function appliedValue(parity: SessionEffortParity): string | undefined {
  return sessionEffortParityValues(parity).applied
}

/**
 * The pill text while requested and applied disagree: what is running, and what was
 * asked for. Never one value — a single value here is what hid the divergence.
 */
export function sessionOptionParityPillLabel(descriptor: SessionOptionDescriptor): string | null {
  const parity = descriptor.parity
  if (!parity) {
    return null
  }
  const requested = requestedValue(parity)
  const applied = appliedValue(parity)
  if (parity.state === 'unsupported' || !applied) {
    return translate(
      'components.native-chat.composer.parity.pillUnavailable',
      '{{value0}} unavailable',
      { value0: requested ? parityValueLabel(descriptor, requested) : '' }
    )
  }
  return translate('components.native-chat.composer.parity.pill', '{{value0}} · asked {{value1}}', {
    value0: parityValueLabel(descriptor, applied),
    value1: requested ? parityValueLabel(descriptor, requested) : ''
  })
}

/** What happened, in the person's terms. Exhaustive: a new reason is a compile error. */
function parityHappenedLine(
  descriptor: SessionOptionDescriptor,
  parity: SessionEffortParity
): string {
  const requested = requestedValue(parity)
  const applied = appliedValue(parity)
  const values = {
    value0: requested ? parityValueLabel(descriptor, requested) : '',
    value1: applied ? parityValueLabel(descriptor, applied) : ''
  }
  switch (parity.reason) {
    case 'effort-differs':
      return translate(
        'components.native-chat.composer.parity.effortDiffers',
        'You asked for {{value0}}; this session reported it is running at {{value1}}.',
        values
      )
    case 'model-differs':
      return translate(
        'components.native-chat.composer.parity.modelDiffers',
        'You asked for {{value0}}; this session reported {{value1}}.',
        values
      )
    case 'effort-dropped':
      return translate(
        'components.native-chat.composer.parity.effortDropped',
        'You asked for {{value0}}; this session reported no effort at all.',
        values
      )
    case 'effort-unsupported':
      return translate(
        'components.native-chat.composer.parity.effortUnsupported',
        '{{value0}} is not available for this model, so it was not applied. Nothing was lowered in its place.',
        values
      )
    case undefined:
      return translate(
        'components.native-chat.composer.parity.unknownDivergence',
        'This session is not running the value you asked for.',
        values
      )
  }
}

/** What to do about it — the send stays on hold until one of these happens. */
function parityNextLine(descriptor: SessionOptionDescriptor, parity: SessionEffortParity): string {
  const applied = appliedValue(parity)
  if (parity.state === 'unsupported' || !applied) {
    return translate(
      'components.native-chat.composer.parity.nextPickSupported',
      'Pick a level this model supports before sending.'
    )
  }
  return translate(
    'components.native-chat.composer.parity.nextPickOrKeep',
    'Pick again to re-apply it, or keep {{value0}} to send.',
    { value0: parityValueLabel(descriptor, applied) }
  )
}

export function sessionOptionParityBlockedSendLabel(): string {
  return translate(
    'components.native-chat.composer.parity.sendBlocked',
    'Sending is on hold until this is settled.'
  )
}

/** Tooltip/menu copy for one diverging row: what happened, the hold, then what to do. */
export function sessionOptionParityLines(descriptor: SessionOptionDescriptor): string[] {
  const parity = descriptor.parity
  if (!parity) {
    return []
  }
  return [
    parityHappenedLine(descriptor, parity),
    sessionOptionParityBlockedSendLabel(),
    parityNextLine(descriptor, parity)
  ]
}

/** The menu item that settles a divergence by keeping what the provider reported. */
export function sessionOptionParityKeepLabel(descriptor: SessionOptionDescriptor): string | null {
  const applied = descriptor.parity ? appliedValue(descriptor.parity) : undefined
  if (!applied || descriptor.parity?.state === 'unsupported') {
    return null
  }
  return translate('components.native-chat.composer.parity.keep', 'Keep {{value0}}', {
    value0: parityValueLabel(descriptor, applied)
  })
}
