import { Send } from 'lucide-react'
import { WorkflowError } from '@/components/console-workflows/WorkflowFields'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export function NextStepSubmitFooter({
  summary,
  error,
  beforeSubmit,
  label,
  pendingLabel,
  pending,
  disabled,
  sticky = false,
  fixedWidth = false,
  onSend
}: {
  summary: string
  error: string
  beforeSubmit?: React.ReactNode
  label: string
  pendingLabel?: string
  pending: boolean
  disabled: boolean
  sticky?: boolean
  fixedWidth?: boolean
  onSend: () => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'min-w-0 w-full space-y-3',
        sticky && 'sticky bottom-0 z-10 border-t border-border bg-background py-3'
      )}
      data-next-step-footer
    >
      <WorkflowError message={error} />
      {beforeSubmit}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          data-next-step-summary
        >
          {summary}
        </span>
        <Button
          size="sm"
          className={fixedWidth ? 'w-36 shrink-0' : undefined}
          disabled={pending || disabled}
          onClick={onSend}
          data-next-step-send
        >
          <Send className="size-3.5" />
          {pending ? (pendingLabel ?? translate('nextStep.sending', 'Sending…')) : label}
        </Button>
      </div>
    </div>
  )
}
