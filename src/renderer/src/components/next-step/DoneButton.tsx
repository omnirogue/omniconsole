import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SessionFinishFields, sessionFinishActionLabel } from './SessionFinishFields'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFinishAction } from '@/lib/session-folders'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { BackofficeCompletionEvidenceDialog } from '@/components/task-page/backoffice/backoffice-completion-evidence-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { BackofficeTodoItem } from '../../../../shared/backoffice-work-types'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { doneRefusal, finishNextStep, waitLaterKeyForSubject } from './next-step-actions'
import type { NextStepSubject } from './next-step-subject'

type DoneButtonProps = {
  subject: NextStepSubject
  linkedCard?: BackofficeTodoItem | null
  onDone?: () => void
  visibleLabel?: string
  primary?: boolean
  className?: string
}

/** ✓ Done: this work is finished. */
export function DoneButton(props: DoneButtonProps): React.JSX.Element {
  const scope = useHandoffScope()
  const key = `${scope}:${waitLaterKeyForSubject(props.subject)}:${props.linkedCard?.task_id ?? ''}`
  return <ScopedDoneButton key={key} {...props} />
}

function ScopedDoneButton({
  subject,
  linkedCard = null,
  onDone,
  visibleLabel,
  primary,
  className
}: DoneButtonProps): React.JSX.Element {
  const refusal = doneRefusal(subject, linkedCard)
  const [pending, setPending] = useState(false)
  const [evidenceItem, setEvidenceItem] = useState<BackofficeTodoItem | null>(null)
  const [sessionFinish, setSessionFinish] = useState<SessionFinishAction>({
    action: 'me',
    folderId: SAVED_SESSIONS_FOLDER_ID
  })
  const [finishOpen, setFinishOpen] = useState(false)
  const label = translate('nextStep.done', 'Done')
  const finish = async (resultRef?: string): Promise<void> => {
    setPending(true)
    try {
      const result = await finishNextStep(subject, linkedCard, resultRef, sessionFinish)
      if (result.ok) {
        setEvidenceItem(null)
        setFinishOpen(false)
        toast.success(result.message)
        onDone?.()
      } else if (result.evidenceItem) {
        setEvidenceItem(result.evidenceItem)
      } else {
        toast.error(result.message)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={primary ? 'default' : visibleLabel ? 'outline' : 'ghost'}
            size={visibleLabel ? 'sm' : 'icon-xs'}
            className={cn('gap-1', className)}
            disabled={pending}
            aria-label={visibleLabel ?? label}
            data-next-step-control="done"
            // Why: a refusal is said where it can be read, not hidden in a disabled button's tooltip.
            onClick={() => (refusal ? toast.message(refusal) : void finish())}
          >
            <Check className="size-3.5" />
            {visibleLabel}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {translate(
            'nextStep.doneDescription',
            'Done — Mark this work finished and remove it from your active attention. Linked tasks follow their completion and review rules.'
          )}
        </TooltipContent>
      </Tooltip>
      {subject.kind === 'session' ? (
        <Popover open={finishOpen} onOpenChange={setFinishOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={pending}
              aria-label={translate('nextStep.sessionFinishOptions', 'Session finish options')}
            >
              <ChevronDown className="size-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 space-y-3" align="end">
            <SessionFinishFields value={sessionFinish} onChange={setSessionFinish} />
            <Button
              size="sm"
              className="w-full"
              disabled={pending}
              onClick={() => (refusal ? toast.message(refusal) : void finish())}
            >
              {sessionFinishActionLabel(sessionFinish.action)}
            </Button>
          </PopoverContent>
        </Popover>
      ) : null}
      {evidenceItem && (
        <BackofficeCompletionEvidenceDialog
          key={evidenceItem.task_id}
          item={evidenceItem}
          pending={pending}
          onSubmit={(resultRef) => void finish(resultRef)}
          onDismiss={() => !pending && setEvidenceItem(null)}
        />
      )}
    </>
  )
}
