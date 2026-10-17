import { UpNextPopover } from '@/components/next-action/UpNextPopover'
import { UP_NEXT_COMPOSER_ENABLED } from '@/components/next-action/up-next-composer-flag'
import type { NextStepSubject } from './next-step-subject'

export function AddNextButton({
  subject,
  disabledReason = null,
  onSent
}: {
  subject: NextStepSubject
  disabledReason?: string | null
  /** The mount's refresh: a committed chain changes the card this button sits on. */
  onSent?: () => void
}): React.JSX.Element | null {
  if (!UP_NEXT_COMPOSER_ENABLED) {
    return null
  }
  return <UpNextPopover subject={subject} disabledReason={disabledReason} onChanged={onSent} />
}
