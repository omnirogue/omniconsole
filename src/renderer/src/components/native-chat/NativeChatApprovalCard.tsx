import { ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ChatApproval } from './native-chat-interactive-prompt'

export type NativeChatApprovalCardProps = {
  approval: ChatApproval
  isSubmitting?: boolean
  deliveryFailed?: boolean
  /** The sender maps the choice to the owning agent's approval protocol. */
  onChoose: (send: string) => void
}

/**
 * Native renderer for an agent tool-approval (PermissionRequest) as an
 * Allow/Deny card. Remains visible and disabled until runtime delivery settles.
 */
export function NativeChatApprovalCard({
  approval,
  isSubmitting = false,
  deliveryFailed = false,
  onChoose
}: NativeChatApprovalCardProps): React.JSX.Element {
  return (
    <div className="shrink-0 bg-background" aria-busy={isSubmitting}>
      <div className="mx-auto w-full max-w-4xl px-3 pt-2 pb-1 sm:px-4">
        <div className="flex w-full flex-col gap-2 rounded-lg border border-input bg-card px-4 py-3 shadow-xs">
          <div className="flex items-start gap-2">
            <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">{approval.title}</p>
              {approval.detail ? (
                <p className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground scrollbar-sleek">
                  {approval.detail}
                </p>
              ) : null}
            </div>
          </div>
          {deliveryFailed ? (
            <p role="alert" className="text-xs text-destructive">
              {translate(
                'components.native-chat.approval.delivery-failed',
                'Could not confirm delivery. Review this request in Terminal before trying again.'
              )}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {approval.options.map((opt, i) => (
              <Button
                key={`${opt.label}-${i}`}
                type="button"
                size="sm"
                variant={i === 0 ? 'default' : 'outline'}
                disabled={isSubmitting}
                onClick={() => onChoose(opt.send)}
              >
                {opt.label}
              </Button>
            ))}
            {isSubmitting ? (
              <span role="status" className="self-center text-xs text-muted-foreground">
                {translate('components.native-chat.question.sending', 'Sending…')}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
