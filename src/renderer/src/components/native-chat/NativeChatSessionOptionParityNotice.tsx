import { TriangleAlert } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import {
  sessionOptionParityKeepLabel,
  sessionOptionParityLines
} from './native-chat-session-option-parity-copy'

/**
 * The menu section for a row whose requested value is not the one the provider
 * reported. It states what happened and what to do, and offers the one action that
 * settles it without pretending the divergence did not happen — keeping what the
 * provider reported. Re-picking the value in the radios below is the other way out.
 *
 * Nothing here grants anything: accepting only stops this row from holding the send.
 */
export function NativeChatSessionOptionParityNotice(props: {
  descriptor: SessionOptionDescriptor
  disabled: boolean
  onAcceptApplied?: () => void
}): React.JSX.Element | null {
  const { descriptor, disabled, onAcceptApplied } = props
  if (!descriptor.parity) {
    return null
  }
  const keepLabel = sessionOptionParityKeepLabel(descriptor)
  return (
    <>
      <DropdownMenuLabel className="font-normal text-xs text-status-warning">
        <span className="flex gap-1.5">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          <span className="space-y-0.5">
            {sessionOptionParityLines(descriptor).map((line) => (
              <span className="block" key={line}>
                {line}
              </span>
            ))}
          </span>
        </span>
      </DropdownMenuLabel>
      {keepLabel && onAcceptApplied ? (
        <DropdownMenuItem disabled={disabled} onSelect={() => onAcceptApplied()}>
          {keepLabel}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
