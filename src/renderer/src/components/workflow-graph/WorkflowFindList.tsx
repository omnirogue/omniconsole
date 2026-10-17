import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  WORKFLOW_FIND_MAX_ITEMS,
  type FindImportReceipt,
  type WorkflowFindItem
} from '../../../../shared/workflow-graph'
import { WorkflowFindScan } from './WorkflowFindScan'

export function WorkflowFindList({
  items,
  onChange
}: {
  items: WorkflowFindItem[]
  onChange: (items: WorkflowFindItem[], receipt?: FindImportReceipt) => void
}) {
  const structured = items.some((item) => typeof item !== 'string')
  return (
    <div className="col-span-2 space-y-3">
      <div className="space-y-2">
        <Label htmlFor="find-own-list">
          {structured
            ? translate('workflowGraph.scan.preview', 'Imported options')
            : translate('workflowGraph.find.yourList', 'Your options, one per line')}
        </Label>
        <Textarea
          id="find-own-list"
          rows={6}
          className="text-xs"
          readOnly={structured}
          value={items
            .map((item) =>
              typeof item === 'string'
                ? item
                : [item.title, item.detail, item.url].filter(Boolean).join(' — ')
            )
            .join('\n')}
          placeholder={translate(
            'workflowGraph.find.yourListPlaceholderFacts',
            'Paste up to {{max}}: names, links, ideas… Repositories as owner/name or GitHub links are judged on live GitHub facts.',
            { max: WORKFLOW_FIND_MAX_ITEMS }
          )}
          onChange={(event) => onChange(event.target.value.split('\n'))}
        />
        {structured && (
          <Button type="button" size="xs" variant="ghost" onClick={() => onChange([])}>
            {translate('workflowGraph.scan.clear', 'Clear imported options')}
          </Button>
        )}
      </div>
      <WorkflowFindScan onItems={onChange} />
    </div>
  )
}
