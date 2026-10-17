import { taskOutcomeRows } from '../../../../../shared/task-outcome-rows'
import { useShownSessionChains } from '@/lib/session-chain-registry'
import { translate } from '@/i18n/i18n'

export function BackofficeTaskOutcomes({ taskId }: { taskId: string }) {
  const rows = taskOutcomeRows(useShownSessionChains(), taskId)
  const statusLabels = {
    pending: translate('taskOutcomes.pending', 'Pending'),
    running: translate('taskOutcomes.running', 'Running'),
    blocked: translate('taskOutcomes.blocked', 'Blocked'),
    satisfied: translate('taskOutcomes.satisfied', 'Satisfied')
  }
  return (
    <section className="space-y-2" aria-label={translate('taskOutcomes.title', 'Outcomes')}>
      <h3 className="text-sm font-semibold">{translate('taskOutcomes.title', 'Outcomes')}</h3>
      {!rows.length && (
        <p className="text-xs text-muted-foreground">
          {translate('taskOutcomes.empty', 'No outcomes attached yet.')}
        </p>
      )}
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={JSON.stringify([row.owner, row.chainId, row.outcomeId])}
            className="rounded-md border border-border p-2 text-xs"
          >
            <p>
              {translate(
                'taskOutcomes.row',
                '{{title}} · {{satisfied}}/{{total}} done-when · {{glyph}}',
                { ...row, glyph: row.lastStageGlyph }
              )}
            </p>
            <p className="text-muted-foreground">{statusLabels[row.status]}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
