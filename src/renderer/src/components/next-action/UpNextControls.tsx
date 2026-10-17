import { UpNextPopover } from './UpNextPopover'
import { UpNextSubject } from './UpNextSubject'
import { UP_NEXT_COMPOSER_ENABLED } from './up-next-composer-flag'
import { useSessionChainForRow } from '@/lib/session-chain-registry'
import type { NextStepSubject } from '../next-step/next-step-subject'

/**
 * The single Up next mount every row uses. Round 4 landed a Done that really finishes inside the
 * composer (`up-next-commit-finish.ts`), so there is no finish door beside the composer any more:
 * the composer's own Done is the only way to finish from here.
 */
export function UpNextControls(props: {
  subject: NextStepSubject
  addDisabledReason?: string | null
  status?: React.ReactNode
  onChanged?: () => void
  workRail?: boolean
}) {
  const chain = useSessionChainForRow(
    props.subject.kind === 'session' ? props.subject.session.rowKey : null
  )
  // With the composer off, the popover stays only where it shows a plan the conversation filed.
  if (!UP_NEXT_COMPOSER_ENABLED && !props.workRail && !chain?.outcomeSet) {
    return null
  }
  return props.workRail ? (
    <UpNextSubject subject={props.subject} onChanged={props.onChanged} />
  ) : (
    <UpNextPopover
      subject={props.subject}
      disabledReason={props.addDisabledReason}
      onChanged={props.onChanged}
    />
  )
}
