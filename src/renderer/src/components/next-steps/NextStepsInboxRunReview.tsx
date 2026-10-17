import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { InboxRunPlan } from './next-steps-inbox-run-plan'

function formatRunThese(count: number): string {
  return count === 1
    ? translate('nextStepsInbox.runThese_one', 'Run this {{count}}', { count })
    : translate('nextStepsInbox.runThese_other', 'Run these {{count}}', { count })
}

/**
 * The review "Run all safe" opens: every exact prompt it would send, by session, and what it
 * leaves to the person. Nothing is sent until "Run these N".
 */
export function NextStepsInboxRunReview({
  plan,
  busy,
  onConfirm,
  onCancel
}: {
  plan: InboxRunPlan | null
  busy: boolean
  onConfirm: (plan: InboxRunPlan) => void
  onCancel: () => void
}) {
  return (
    <Dialog open={plan !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{translate('nextStepsInbox.reviewTitle', 'Run all safe steps')}</DialogTitle>
          <DialogDescription>
            {translate(
              'nextStepsInbox.reviewDescription',
              'These exact prompts will be sent, each as your own message in its session.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto scrollbar-sleek text-xs">
          {plan?.entries.map((entry) => (
            <section key={entry.key} data-review-session={entry.key}>
              <h3 className="font-medium">{entry.label}</h3>
              <ol className="mt-1 space-y-1">
                {entry.steps.map((step) => (
                  <li key={step.id} className="rounded-md border border-border p-2">
                    <p className="font-medium">{step.title}</p>
                    <p
                      className="mt-1 whitespace-pre-wrap break-words text-muted-foreground"
                      data-review-prompt={`${entry.setId}:${step.id}`}
                    >
                      {step.prompt}
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          ))}
          {plan?.needsYou.length ? (
            <section>
              <h3 className="font-medium">
                {translate('nextStepsInbox.needsYouTitle', 'Not sent — needs you')}
              </h3>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                {plan.needsYou.map((item) => (
                  <li key={`${item.key}:${item.reason}`}>
                    {item.label}: {item.reason}
                    {item.titles.length ? ` (${item.titles.join('; ')})` : ''}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            {translate('nextStepsInbox.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={busy || !plan?.count}
            onClick={() => (plan ? onConfirm(plan) : undefined)}
          >
            {formatRunThese(plan?.count ?? 0)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
