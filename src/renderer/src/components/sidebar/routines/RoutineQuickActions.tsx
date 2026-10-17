import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useRoutineForTab } from './routine-conversation-state'

export function RoutineQuickActions({
  tabId,
  paneKey,
  disabled,
  onChoose
}: {
  tabId: string
  paneKey: string
  disabled: boolean
  onChoose: (prompt: string) => void
}) {
  const routine = useRoutineForTab(tabId, paneKey)
  if (!routine) {
    return null
  }
  const advertising = /\b(ads?|advertising|campaigns?|roas|media buying)\b/i.test(
    `${routine.automation.name} ${routine.automation.prompt}`
  )
  const questions = advertising
    ? [
        translate(
          'routines.adsEnableQuestion',
          'What are the highest probability ads we can turn on?'
        ),
        translate(
          'routines.adsDisableQuestion',
          'What are the lowest probability ads we can shut off?'
        )
      ]
    : [translate('routines.reviewQuestion', 'What should we do next?')]
  return (
    <div
      className="flex shrink-0 flex-wrap gap-2 px-3 py-2"
      aria-label={translate('routines.quickActions', 'Routine quick actions')}
    >
      {questions.map((question) => (
        <Button
          key={question}
          size="sm"
          variant="outline"
          disabled={disabled}
          className="h-auto whitespace-normal text-left"
          onClick={() =>
            onChoose(
              [
                `Routine: ${routine.automation.name}`,
                routine.automation.prompt,
                question,
                advertising
                  ? 'Use current evidence for this routine’s company and ad account. Rank the specific ads with their IDs, estimated probability, uncertainty, and expected impact. Do not invent probability estimates when evidence is missing.'
                  : 'Review current evidence and propose the next specific action.',
                'Do not make changes yet. Present the exact proposed changes, then use the interactive question tool to ask for confirmation with Yes and No buttons (for example, “Turn these ads off?”). Only act on the specific proposal after Yes; No leaves it unchanged. Report the actual result.'
              ].join('\n\n')
            )
          }
        >
          {question}
        </Button>
      ))}
    </div>
  )
}
