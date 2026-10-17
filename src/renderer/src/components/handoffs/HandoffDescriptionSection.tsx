import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { readHandoffVersionText } from './handoff-client'

function HandoffSummary({
  threadId,
  file
}: {
  threadId: string
  file: HandoffDetail['files'][number]
}) {
  const [text, setText] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    let live = true
    void readHandoffVersionText(threadId, file)
      .then((value) => {
        if (live) {
          setText(value.slice(0, 20_000))
        }
      })
      .catch(() => {
        if (live) {
          setUnavailable(true)
        }
      })
    return () => {
      live = false
    }
  }, [threadId, file])
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground">
        {translate('handoffs.summary12b71', 'Summary')}
      </h3>
      {text !== null ? (
        <CommentMarkdown content={text} className="text-sm" />
      ) : (
        <p className="text-xs text-muted-foreground">
          {unavailable
            ? translate('handoffs.summaryUnavailable9f419', 'Summary unavailable.')
            : translate('handoffs.summaryLoading9deab', 'Loading summary…')}
        </p>
      )}
    </div>
  )
}

export function HandoffDescriptionSection({
  detail,
  summary
}: {
  detail: HandoffDetail
  summary: HandoffDetail['files'][number] | null
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold text-muted-foreground">
        {translate('handoffs.description55f8e', 'Description')}
      </h2>
      <CommentMarkdown
        content={detail.entries.find((entry) => entry.kind === 'handoff')?.body ?? ''}
        className="text-sm"
      />
      {summary && (
        <HandoffSummary
          key={`${detail.thread.id}:${summary.id}`}
          threadId={detail.thread.id}
          file={summary}
        />
      )}
    </section>
  )
}
