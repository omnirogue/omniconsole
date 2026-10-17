import { useState } from 'react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import type { BuildReviewPendingQuestion } from '../../../../shared/build-review-pipeline'

export function BuildReviewQuestionCard({
  pipelineId,
  question
}: {
  pipelineId: string
  question: BuildReviewPendingQuestion
}) {
  const reply = useAppStore((s) => s.buildReview.reply)
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (error) {
      setError(String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <form
      className="space-y-3 rounded-md border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!pending && body.trim()) {
          void perform(async () => {
            await reply(pipelineId, question.messageId, body.trim())
            setBody('')
          })
        }
      }}
    >
      <h3 className="text-sm font-medium">
        {translate(
          'auto.components.build-review.BuildReviewDetail.question',
          'Waiting for your reply'
        )}
      </h3>
      <p className="whitespace-pre-wrap text-sm">{question.question}</p>
      {question.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {[...new Set(question.options)].map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setBody(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <Label htmlFor="build-review-reply">
        {translate('auto.components.build-review.BuildReviewDetail.answer', 'Reply')}
      </Label>
      <Textarea
        id="build-review-reply"
        value={body}
        disabled={pending}
        onChange={(event) => setBody(event.target.value)}
      />
      <Button type="submit" size="sm" disabled={pending || !body.trim()}>
        {translate('auto.components.build-review.BuildReviewDetail.send', 'Send reply')}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
