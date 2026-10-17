import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import type { AutomationRun } from '../../../../shared/automations-types'
import { getAutomationRunMessage } from './automation-run-content'

/**
 * The run's message as a person should read it: the `omni-actions` fence never renders as
 * code — the card above shows it, or one plain line says what the block amounted to.
 */
export function AutomationRunMessage({
  run,
  cardShown
}: {
  run: AutomationRun
  cardShown: boolean
}) {
  const message = getAutomationRunMessage(run)
  const note =
    message.recommendations === 'empty'
      ? translate(
          'auto.components.automations.AutomationRunMessage.noChanges',
          'No changes recommended.'
        )
      : message.recommendations === 'unreadable' && !cardShown
        ? translate(
            'auto.components.automations.AutomationRunMessage.unreadable',
            'Recommendations could not be read from this run.'
          )
        : message.recommendations === 'ready' && !cardShown
          ? translate(
              'auto.components.automations.AutomationRunMessage.count',
              '{count} recommendations',
              { count: message.actions.length }
            )
          : null
  return (
    <div className="space-y-3">
      {message.scraped ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.AutomationRunMessage.scraped',
            "Shown from the terminal screen; the agent's message was not recorded for this run."
          )}
        </p>
      ) : null}
      <CommentMarkdown
        variant="document"
        content={message.text}
        className="text-sm leading-relaxed text-foreground"
      />
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </div>
  )
}
