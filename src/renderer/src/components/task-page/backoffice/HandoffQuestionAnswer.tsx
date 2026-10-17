import { useState } from 'react'
import { toast } from 'sonner'
import { handoffApi } from '@/components/handoffs/handoff-client'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { consoleWorkflowApi } from '@/lib/console-workflow-client'
import type { BackofficeTodoItem } from '../../../../../shared/backoffice-work-types'
import type { ConsoleHandoffQuestionDecideRequest } from '../../../../../shared/console-handoff-question'
import { invalidateBackofficeWork } from './backoffice-work-store'
import { markHandoffQuestionAnswered } from './handoff-question-answered'

const NOT_NEEDED_NOTE = 'Not needed (cleared from Work).'

/** Whether this Work row is an agent's handoff question Work can answer in place. */
export function isAnswerableHandoffQuestion(item: BackofficeTodoItem | undefined): boolean {
  return Boolean(item?.decision_id && item.primary_action?.handoff_options?.length)
}

/**
 * An agent's handoff question answered from Work: one of its options, or Not needed. Only the
 * hub's decide write clears it; a reply or Complete leaves it in Needs you. Mount it keyed by
 * `decision_id`: its answered state belongs to one question.
 */
export function HandoffQuestionAnswer({
  item
}: {
  item: BackofficeTodoItem
}): React.JSX.Element | null {
  const [pending, setPending] = useState<string | null>(null)
  const [answered, setAnswered] = useState(false)
  const decisionId = item.decision_id
  const options = item.primary_action?.handoff_options
  if (!decisionId || !options?.length) {
    return null
  }
  const recommended = item.primary_action?.handoff_recommended ?? null
  const decide = async (
    key: string,
    request: Omit<ConsoleHandoffQuestionDecideRequest, 'decisionId'>
  ): Promise<void> => {
    setPending(key)
    try {
      const result = await consoleWorkflowApi().decideHandoffQuestion({ decisionId, ...request })
      // Why already_decided counts: it was answered elsewhere, so it leaves Needs you all the same.
      if (!result.ok && result.error.code !== 'already_decided') {
        toast.error(result.error.message)
        return
      }
      setAnswered(true)
      markHandoffQuestionAnswered(decisionId)
      // Why: the hub's decide resolves the thread but leaves no read receipt for this reader, so
      // its entries stay unread and the resolved thread would come back to Needs you as a reply.
      const threadId = item.primary_action?.handoff_thread_id
      if (threadId) {
        await handoffApi()
          .markRead({ threadId })
          .catch(() => undefined)
      }
      invalidateBackofficeWork()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(null)
    }
  }
  if (answered) {
    return (
      <span className="text-xs text-muted-foreground" data-handoff-question-answered="">
        {translate('backofficeWork.questionAnswered', 'Answered')}
      </span>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-handoff-question={decisionId}>
      {options.map((option) => (
        <Button
          key={option.value}
          size="xs"
          variant={option.value === recommended ? 'default' : 'outline'}
          disabled={pending !== null}
          title={
            option.value === recommended
              ? translate('backofficeWork.questionRecommended', 'The agent recommends this')
              : undefined
          }
          onClick={() => void decide(option.value, { action: 'reply', value: option.value })}
        >
          {option.label}
        </Button>
      ))}
      <Button
        size="xs"
        variant="ghost"
        disabled={pending !== null}
        onClick={() => void decide('deny', { action: 'deny', note: NOT_NEEDED_NOTE })}
      >
        {translate('backofficeWork.questionNotNeeded', 'Not needed')}
      </Button>
    </div>
  )
}
