import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { BackofficeTodoItem } from '../../../../../shared/backoffice-work-types'

/* The hub refuses "done" on a card that names an owner and acceptance criteria
 * until a result ref exists. This asks for that one thing, in plain words,
 * and the caller retries the completion with it. */
export function BackofficeCompletionEvidenceDialog({
  item,
  pending,
  onSubmit,
  onDismiss
}: {
  item: BackofficeTodoItem
  pending: boolean
  onSubmit: (resultRef: string) => void
  onDismiss: () => void
}): React.JSX.Element {
  const [resultRef, setResultRef] = useState('')
  const ready = resultRef.trim().length > 0 && !pending
  return (
    <Dialog open onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent data-testid="backoffice-completion-evidence" className="sm:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (ready) {
              onSubmit(resultRef.trim())
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.TaskPage.evidenceTitle', 'What shows this is done?')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.TaskPage.evidenceBody',
                '“{{title}}” has an owner and acceptance criteria, so the hub records one piece of evidence before it closes. Paste a link (pull request, CI run, document) or write one sentence.',
                { title: item.title }
              )}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={resultRef}
            onChange={(event) => setResultRef(event.target.value)}
            placeholder={translate(
              'auto.components.TaskPage.evidencePlaceholder',
              'https://github.com/…/pull/123 or “verified on my Mac, sidebar shows Jira”'
            )}
            maxLength={2048}
            className="mt-3"
            aria-label={translate('auto.components.TaskPage.evidenceLabel', 'Evidence')}
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" size="sm" onClick={onDismiss} disabled={pending}>
              {translate('auto.components.TaskPage.evidenceCancel', 'Not yet')}
            </Button>
            <Button type="submit" size="sm" disabled={!ready}>
              {translate('chatActions.complete', 'Complete')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
