import { useState } from 'react'
import { BellOff, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ConsoleDecisionsBulkDismiss } from '../../../../../shared/console-workflow-types'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { consoleWorkflowApi } from '@/lib/console-workflow-client'

/** "3 stale sends, 2 crashed reconciles" — the hub's own classes, read as words. */
export function dismissBreakdown(preview: ConsoleDecisionsBulkDismiss): string {
  return Object.entries(preview.by_class)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name.replace(/_/g, ' ')}`)
    .join(', ')
}

/**
 * Dismiss: every machine-generated decision in the signed-in person's queue, in one
 * go. The hub counts first (a dry run) so the person confirms a number, never a guess;
 * decisions a person raised are untouched and stay for a real answer.
 */
export function DismissDecisionsButton({
  onDismissed
}: {
  onDismissed: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<ConsoleDecisionsBulkDismiss | null>(null)
  const [error, setError] = useState<string | null>(null)
  const label = translate('backofficeWork.dismissDecisions', 'Dismiss decisions')
  const count = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setPreview(null)
    const result = await consoleWorkflowApi().dismissMachineDecisions({ dryRun: true })
    setBusy(false)
    if (result.ok) {
      setPreview(result.data)
    } else {
      setError(result.error.message)
    }
  }
  const dismiss = async (): Promise<void> => {
    setBusy(true)
    const result = await consoleWorkflowApi().dismissMachineDecisions({ dryRun: false })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setOpen(false)
    toast.success(
      translate('backofficeWork.dismissedDecisions', 'Dismissed {{count}} decisions.', {
        count: result.data.dismissed
      })
    )
    onDismissed()
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          void count()
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={label} data-dismiss-decisions="">
              <BellOff className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="w-72 space-y-2 text-xs"
        data-dismiss-decisions-panel=""
      >
        {busy && !preview ? (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {translate('backofficeWork.dismissCounting', 'Counting…')}
          </p>
        ) : error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : preview && preview.matched === 0 ? (
          <p className="text-muted-foreground">
            {translate(
              'backofficeWork.dismissNothing',
              'Nothing to dismiss. Every decision here was raised by a person.'
            )}
          </p>
        ) : preview ? (
          <>
            <p className="font-medium">
              {translate(
                'backofficeWork.dismissConfirm',
                'Dismiss {{count}} machine-generated decisions?',
                {
                  count: preview.matched
                }
              )}
            </p>
            {dismissBreakdown(preview) ? (
              <p className="text-muted-foreground">{dismissBreakdown(preview)}</p>
            ) : null}
            <p className="text-muted-foreground">
              {translate('backofficeWork.dismissKeepsPeople', 'Decisions a person raised stay.')}
            </p>
            <div className="flex justify-end gap-1.5">
              <Button variant="ghost" size="xs" onClick={() => setOpen(false)} disabled={busy}>
                {translate('common.cancel', 'Cancel')}
              </Button>
              <Button size="xs" onClick={() => void dismiss()} disabled={busy}>
                {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
                {translate('backofficeWork.dismissAction', 'Dismiss')}
              </Button>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
