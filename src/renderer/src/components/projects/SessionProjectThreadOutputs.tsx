import React, { useState } from 'react'
import { SearchCheck, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { sendSessionReply } from '@/lib/session-reply-send'
import { sessionProjectFixCiPrompt } from '@/lib/session-project-thread-outputs'
import type { SessionProjectThread } from '@/lib/session-project-threads'
import { cn } from '@/lib/utils'
import type { CheckStatus } from '../../../../shared/github/pull-request-types'
import { reviewStateLabel } from './session-project-status-labels'
import { useSessionProjectOutputs } from './use-session-project-review'

function checksLabel(checks: CheckStatus): string | null {
  switch (checks) {
    case 'pending':
      return translate('projects.outputs.ciRunning', 'CI running')
    case 'success':
      return translate('projects.outputs.ciPassing', 'CI passing')
    case 'failure':
      return translate('projects.outputs.ciFailing', 'CI failing')
    case 'neutral':
      return null
  }
}

/** Sends the failing review to its own thread; nothing runs on its own. */
function FixCiButton({
  thread,
  review
}: {
  thread: SessionProjectThread
  review: { label: string; url: string }
}): React.JSX.Element {
  const [sending, setSending] = useState(false)
  return (
    <button
      type="button"
      disabled={sending}
      className="inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
      data-session-project-fix-ci=""
      onClick={() => {
        setSending(true)
        sendSessionReply(thread.row.session, sessionProjectFixCiPrompt(review))
          .then(() =>
            toast.success(
              translate('projects.outputs.fixCiSent', 'Asked {{label}} to fix CI.', {
                label: thread.row.session.label
              })
            )
          )
          .catch((cause: unknown) =>
            toast.error(cause instanceof Error ? cause.message : String(cause))
          )
          .finally(() => setSending(false))
      }}
    >
      <Wrench className="size-2.5" aria-hidden />
      {translate('projects.outputs.fixCi', 'Fix CI')}
    </button>
  )
}

export type SessionProjectReviewAction = (
  thread: SessionProjectThread,
  review: { label: string; url: string }
) => void

/** The thread's pull or merge request with its CI, and the issue it serves, under its row. */
export function SessionProjectThreadOutputs({
  thread,
  canSend,
  onReview
}: {
  thread: SessionProjectThread
  /** The thread takes a follow-up from the page, so a failing review offers Fix CI. */
  canSend: boolean
  /** A Ready for review thread's open review offers Review, which starts a Reviewer thread. */
  onReview?: SessionProjectReviewAction
}): React.JSX.Element | null {
  const outputsFor = useSessionProjectOutputs()
  const outputs = outputsFor(thread)
  if (outputs.length === 0) {
    return null
  }
  return (
    <span className="contents" data-session-project-outputs={outputs.length}>
      {outputs.map((output) => {
        if (output.kind === 'issue') {
          return (
            <span
              key={`issue:${output.label}`}
              className="rounded-full border px-1.5 py-px text-[10px] text-muted-foreground"
              data-session-project-output="issue"
            >
              {output.label}
            </span>
          )
        }
        const open = output.state === 'open' || output.state === 'draft'
        const ci = open ? output.checks : 'neutral'
        const ciLabel = checksLabel(ci)
        return (
          <React.Fragment key={`review:${output.url}`}>
            <a
              href={output.url}
              target="_blank"
              rel="noreferrer"
              className={cn(
                'rounded-full border px-1.5 py-px text-[10px] text-muted-foreground hover:text-foreground',
                ci === 'failure' && 'border-destructive/40 text-destructive'
              )}
              data-session-project-output="review"
              data-session-project-ci={ci}
            >
              {translate('projects.outputs.review', 'PR {{label}} {{state}}', {
                label: output.label,
                state: reviewStateLabel(output.state)
              })}
              {ciLabel ? ` · ${ciLabel}` : null}
            </a>
            {ci === 'failure' && canSend ? <FixCiButton thread={thread} review={output} /> : null}
            {onReview && thread.status === 'reviewReady' && open ? (
              <button
                type="button"
                className="inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[10px] text-muted-foreground hover:text-foreground"
                data-session-project-review-start=""
                onClick={() => onReview(thread, output)}
              >
                <SearchCheck className="size-2.5" aria-hidden />
                {translate('projects.outputs.reviewStart', 'Review')}
              </button>
            ) : null}
          </React.Fragment>
        )
      })}
    </span>
  )
}
