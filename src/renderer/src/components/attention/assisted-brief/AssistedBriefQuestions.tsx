import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { sectionsOverflowedByAnswers } from '../../../../../shared/assisted-brief-revisions'
import type { BriefContent } from '../../../../../shared/assisted-brief-types'
import { briefSectionFullLabel } from './assisted-brief-labels'
import type { BriefCommitResult } from './use-assisted-brief'

/** The drafter's questions, asked together, each with one-click answers and a typed fallback. */
export function AssistedBriefQuestions({
  content,
  disabled,
  onApply
}: {
  content: BriefContent
  disabled: boolean
  onApply: (answers: Record<string, string>) => BriefCommitResult
}): React.JSX.Element {
  const { questions } = content
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const answered = questions.filter((question) => answers[question.id]?.trim()).length
  const [overflowed] = sectionsOverflowedByAnswers(content, answers)
  const setAnswer = (id: string, value: string): void =>
    setAnswers((current) => ({ ...current, [id]: value }))
  return (
    <section className="space-y-2 rounded-md border border-border p-2" data-brief-questions="">
      <div className="space-y-0.5">
        <h3 className="text-xs font-medium text-foreground">
          {translate('assistedBrief.questionsTitle', 'Questions that change the work')}
        </h3>
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'assistedBrief.questionsHelp',
            'Answer what you can. The session asks you about the rest before relying on it.'
          )}
        </p>
      </div>
      {questions.map((question) => {
        const answer = answers[question.id] ?? ''
        return (
          <div key={question.id} className="space-y-1">
            <p className="text-sm">{question.prompt}</p>
            {question.choices.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {question.choices.map((choice) => (
                  <Button
                    key={choice}
                    type="button"
                    size="xs"
                    variant={answer === choice ? 'secondary' : 'outline'}
                    aria-pressed={answer === choice}
                    disabled={disabled}
                    onClick={() => setAnswer(question.id, answer === choice ? '' : choice)}
                  >
                    {choice}
                  </Button>
                ))}
              </div>
            ) : null}
            <Input
              value={question.choices.includes(answer) ? '' : answer}
              disabled={disabled}
              onChange={(event) => setAnswer(question.id, event.target.value)}
              placeholder={translate('assistedBrief.otherAnswer', 'Or type an answer')}
              aria-label={translate('assistedBrief.answerFor', 'Answer for: {{question}}', {
                question: question.prompt
              })}
              className="h-7 text-xs"
            />
          </div>
        )
      })}
      {overflowed ? (
        <p role="alert" className="text-xs text-destructive">
          {briefSectionFullLabel(overflowed)}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled || answered === 0 || overflowed !== undefined}
        onClick={() => {
          if (onApply(answers) === 'saved') {
            setAnswers({})
          }
        }}
      >
        {translate('assistedBrief.applyAnswers', 'Add answers to the brief')}
      </Button>
    </section>
  )
}
