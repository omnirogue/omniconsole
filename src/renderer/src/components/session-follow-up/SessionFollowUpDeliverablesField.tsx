import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { followUpTriggerText } from '@/lib/session-follow-up-messages'
import type { FollowUpFormState } from './session-follow-up-draft'

/** Which files go: the run's declared deliverables, or files the person names; plus a summary. */
export function SessionFollowUpDeliverablesField({
  form,
  disabled,
  onChange
}: {
  form: FollowUpFormState
  disabled?: boolean
  onChange: (update: (form: FollowUpFormState) => FollowUpFormState) => void
}): React.JSX.Element {
  const filesId = useId()
  const manifest = form.deliverableMode === 'manifest' && form.manifestPath
  const summaryLabel = translate('sessionFollowUp.includeSummary', 'Add a final summary')
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {translate('sessionFollowUp.whatToSend', 'What to send')}
      </legend>
      <div role="group" className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={manifest ? 'secondary' : 'outline'}
          aria-pressed={!!manifest}
          disabled={disabled || !form.manifestPath}
          onClick={() => onChange((current) => ({ ...current, deliverableMode: 'manifest' }))}
        >
          {translate('sessionFollowUp.finalFromRun', 'Final deliverables from this run')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={manifest ? 'outline' : 'secondary'}
          aria-pressed={!manifest}
          disabled={disabled}
          onClick={() => onChange((current) => ({ ...current, deliverableMode: 'files' }))}
        >
          {translate('sessionFollowUp.namedFiles', 'Named files')}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {followUpTriggerText({
          deliverables: manifest
            ? { kind: 'manifest', manifestPath: form.manifestPath ?? '' }
            : { kind: 'files', paths: [] }
        })}
      </p>
      {!form.manifestPath ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'sessionFollowUp.noManifest',
            'OmniConsole knows of no run manifest for this session, so name the output files.'
          )}
        </p>
      ) : null}
      {manifest ? (
        <p className="break-all font-mono text-[11px] text-muted-foreground">
          {translate('sessionFollowUp.manifestAt', 'Files listed in {{path}}', {
            path: form.manifestPath
          })}
        </p>
      ) : (
        <div className="space-y-1">
          <Label htmlFor={filesId} className="text-xs">
            {translate('sessionFollowUp.filesLabel', 'Output files')}
          </Label>
          <Textarea
            id={filesId}
            rows={3}
            value={form.filesText}
            disabled={disabled}
            className="font-mono text-xs"
            placeholder={translate(
              'sessionFollowUp.filesPlaceholder',
              'One file per line, relative to the workspace, e.g. out/report.md'
            )}
            onChange={(event) =>
              onChange((current) => ({ ...current, filesText: event.target.value }))
            }
          />
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'sessionFollowUp.filesHelp',
              'Only these files are sent, with their exact bytes. Nothing else in the workspace is included.'
            )}
          </p>
        </div>
      )}
      <label className="flex items-start gap-2 text-xs">
        <Checkbox
          checked={form.includeSummary}
          disabled={disabled}
          aria-label={summaryLabel}
          onCheckedChange={(checked) =>
            onChange((current) => ({ ...current, includeSummary: checked === true }))
          }
        />
        <span>
          <span className="font-medium">{summaryLabel}</span>
          <span className="block text-muted-foreground">
            {translate(
              'sessionFollowUp.includeSummaryHelp',
              "A Markdown file of the session's final output, named after the session."
            )}
          </span>
        </span>
      </label>
    </fieldset>
  )
}
