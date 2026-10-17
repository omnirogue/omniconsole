import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { ConsoleWorkflowApi } from '../../../../../shared/console-workflow-api'

export type MoveDetails = Pick<
  Parameters<ConsoleWorkflowApi['transitionTask']>[0],
  'reason' | 'resultRef' | 'waitingOn' | 'followUpAt'
>
export type MoveDetailsKind = 'wait' | 'resume' | 'review'

/** Collect the existing lifecycle fields before any tag or state write. */
export function BackofficeMoveDetailsDialog({
  kind,
  title,
  pending,
  error,
  onSubmit,
  onDismiss
}: {
  kind: MoveDetailsKind
  title: string
  pending: boolean
  error: string | null
  onSubmit: (details: MoveDetails) => void
  onDismiss: () => void
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  const [reason, setReason] = useState('')
  const [waitingOn, setWaitingOn] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [evidence, setEvidence] = useState('')
  const future =
    !!followUp &&
    Number.isFinite(new Date(followUp).getTime()) &&
    new Date(followUp).getTime() > now
  const ready =
    !pending &&
    (kind === 'review' ? !!evidence.trim() : !!reason.trim()) &&
    (kind !== 'wait' || !!waitingOn.trim() || future) &&
    (!followUp || future)
  const heading =
    kind === 'wait'
      ? translate('workKanban.waitHeading', 'What is this waiting for?')
      : kind === 'resume'
        ? translate('workKanban.resumeHeading', 'How was the blocker resolved?')
        : translate('workKanban.reviewHeading', 'What is ready for review?')
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onDismiss()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            const submittedAt = Date.now()
            setNow(submittedAt)
            if (followUp && new Date(followUp).getTime() <= submittedAt) {
              return
            }
            if (ready) {
              onSubmit(
                kind === 'review'
                  ? { resultRef: evidence.trim() }
                  : {
                      reason: reason.trim(),
                      ...(kind === 'wait' && waitingOn.trim()
                        ? { waitingOn: waitingOn.trim() }
                        : {}),
                      ...(kind === 'wait' && future
                        ? { followUpAt: new Date(followUp).toISOString() }
                        : {})
                    }
              )
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{heading}</DialogTitle>
            <DialogDescription>{title}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="move-context">
              {kind === 'review'
                ? translate('workKanban.evidence', 'Evidence')
                : translate('workKanban.reason', 'Reason')}
            </Label>
            <Input
              id="move-context"
              autoFocus
              disabled={pending}
              value={kind === 'review' ? evidence : reason}
              maxLength={kind === 'review' ? 2000 : 4000}
              onChange={(event) =>
                kind === 'review' ? setEvidence(event.target.value) : setReason(event.target.value)
              }
            />
          </div>
          {kind === 'wait' && (
            <>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'workKanban.waitHelp',
                  'Name the person or external party you are waiting for, or choose a future follow-up time.'
                )}
              </p>
              <div className="space-y-2">
                <Label htmlFor="move-waiting-on">
                  {translate('workKanban.waitingFor', 'Waiting for')}
                </Label>
                <Input
                  id="move-waiting-on"
                  value={waitingOn}
                  maxLength={512}
                  disabled={pending}
                  onChange={(event) => setWaitingOn(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="move-follow-up">
                  {translate('workKanban.followUpAt', 'Follow up at')}
                </Label>
                <Input
                  id="move-follow-up"
                  type="datetime-local"
                  value={followUp}
                  disabled={pending}
                  onChange={(event) => setFollowUp(event.target.value)}
                />
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onDismiss}>
              {translate('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!ready}>
              {pending
                ? translate('workKanban.moving', 'Moving…')
                : translate('workKanban.moveTask', 'Move task')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
