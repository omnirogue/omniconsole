import {
  DEFAULT_DELIVERY,
  deliveryRowIdentity,
  replaceDeliveryRow
} from './automation-delivery-row-identity'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type {
  AutomationDelivery,
  AutomationOutputFormat
} from '../../../../shared/automation-definition-context'
import type { AutomationDraft } from './AutomationEditorDialog'
import { automationDeliveryLabel as deliveryLabel } from './automation-delivery-label'

function destination(kind: AutomationDelivery['kind'], value: string): AutomationDelivery {
  switch (kind) {
    case 'chat':
      return { kind }
    case 'slack':
      return { kind, channel: value }
    case 'google-drive':
      return { kind, folderId: value }
    case 'file':
      return { kind, path: value }
    case 'hub-card':
      return { kind, scope: value }
  }
}
export function AutomationOutputFields({
  draft,
  onDraftChange
}: {
  draft: AutomationDraft
  onDraftChange: (update: (current: AutomationDraft) => AutomationDraft) => void
}) {
  const targets = draft.delivery ?? DEFAULT_DELIVERY
  const update = (index: number, target: AutomationDelivery) =>
    onDraftChange((current) => ({
      ...current,
      delivery: (current.delivery ?? DEFAULT_DELIVERY).map((row, i) =>
        i === index ? replaceDeliveryRow(row, target) : row
      )
    }))
  return (
    <section className="space-y-3" data-routine-output>
      <Label>{translate('routines.output.title', 'Output')}</Label>
      <Select
        value={draft.outputFormat ?? 'markdown'}
        onValueChange={(value) =>
          onDraftChange((current) => ({
            ...current,
            outputFormat: value as AutomationOutputFormat
          }))
        }
      >
        <SelectTrigger aria-label={translate('routines.definition.format', 'Output format')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {['markdown', 'html', 'json', 'csv'].map((format) => (
            <SelectItem key={format} value={format}>
              {format}
            </SelectItem>
          ))}
          {['docx', 'pdf'].map((format) => (
            <Tooltip key={format}>
              <TooltipTrigger asChild>
                <span>
                  <SelectItem value={format} disabled>
                    {format}
                  </SelectItem>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {translate(
                  'routines.output.rendererUnavailable',
                  'A renderer for this format is not installed.'
                )}
              </TooltipContent>
            </Tooltip>
          ))}
        </SelectContent>
      </Select>
      {targets.map((target, index) => (
        <div key={deliveryRowIdentity(target)} className="flex items-center gap-2">
          <Select
            value={target.kind}
            onValueChange={(value) =>
              update(index, destination(value as AutomationDelivery['kind'], ''))
            }
          >
            <SelectTrigger
              aria-label={translate('routines.definition.delivery', 'Delivery')}
              className="w-40 shrink-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['chat', 'slack', 'google-drive', 'file', 'hub-card'] as const).map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {deliveryLabel(kind)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {target.kind !== 'chat' ? (
            <Input
              aria-label={deliveryLabel(target.kind)}
              value={Object.values(target)[1] as string}
              onChange={(event) => update(index, destination(target.kind, event.target.value))}
            />
          ) : (
            <span className="flex-1" />
          )}
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              onDraftChange((current) => ({
                ...current,
                delivery: targets.filter((_, i) => i !== index)
              }))
            }
          >
            {translate('routines.definition.remove', 'Remove')}
          </Button>
        </div>
      ))}
      {targets.some((target) => target.kind === 'google-drive' || target.kind === 'hub-card') ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'routines.output.integrationUnavailable',
            'Google Drive and hub card delivery are not available from this desktop yet. Output remains in the run history, with a failed delivery receipt.'
          )}
        </p>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          onDraftChange((current) => ({ ...current, delivery: [...targets, { kind: 'chat' }] }))
        }
      >
        {translate('routines.output.add', 'Add destination')}
      </Button>
    </section>
  )
}
