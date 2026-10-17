import { useId, useState } from 'react'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { ModelDot } from '@/components/ModelDot'
import type { LocalWorkflowDraft } from '../../../../shared/local-workflow-draft'
import type {
  LocalWorkflowSeatCatalog,
  LocalWorkflowSeatChoice
} from '../../../../shared/local-workflow-seats'
import { localWorkflowProviderLabel } from '../../../../shared/local-workflow-model-label'
import { defaultAuditSeats } from './audit-seat-selection'

export function AuditWorkflowSetup({
  draft,
  team,
  catalog,
  maxConcurrency,
  unavailableReason,
  loading,
  recoveringStart,
  onChange,
  onStart
}: {
  draft: LocalWorkflowDraft
  team: readonly LocalWorkflowSeatChoice[]
  catalog: readonly LocalWorkflowSeatCatalog[]
  maxConcurrency: number
  unavailableReason?: string
  loading?: boolean
  recoveringStart?: boolean
  onChange: (draft: LocalWorkflowDraft) => void
  onStart: (draft: LocalWorkflowDraft) => Promise<void>
}) {
  const id = useId()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const audit = draft.audit!
  const locked = starting || recoveringStart
  const seats = draft.seats.length ? draft.seats : defaultAuditSeats(team, catalog)
  const rows = [
    ...team,
    ...seats.filter((seat) => !team.some((teamSeat) => teamSeat.id === seat.id))
  ]
  const entries = rows.map((teamSeat) => {
    const seat = seats.find((selectedSeat) => selectedSeat.id === teamSeat.id) ?? teamSeat
    return {
      seat,
      checked: seats.some((selectedSeat) => selectedSeat.id === teamSeat.id),
      models:
        catalog
          .find((entry) => entry.agent === seat.agent && entry.accountId === seat.accountId)
          ?.models.filter((model) => model.lineage !== 'unknown' && model.resolvedModelId.trim()) ??
        []
    }
  })
  const selected = entries
    .filter(({ checked }) => checked)
    .map(({ seat, models }) => ({
      ...seat,
      model: seat.model ?? models.find((model) => model.catalog.isDefault)?.catalog.id
    }))
  const ready =
    !!draft.prompt.trim() &&
    !!audit.sourceFile.trim() &&
    selected.length > 0 &&
    selected.every((seat) =>
      entries.some(
        (entry) =>
          entry.checked &&
          entry.seat.id === seat.id &&
          entry.models.some((model) => model.catalog.id === seat.model)
      )
    )
  const start = async () => {
    if (starting || !ready || unavailableReason || loading) {
      return
    }
    setStarting(true)
    setError('')
    try {
      // An uncertain Start reuses its exact persisted draft and operation identity.
      await onStart(
        recoveringStart
          ? draft
          : {
              ...draft,
              prompt: draft.prompt.trim(),
              audit: { ...audit, sourceFile: audit.sourceFile.trim() },
              seats: selected,
              concurrency: Math.min(draft.concurrency, maxConcurrency)
            }
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setStarting(false)
    }
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void start()
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={`${id}-question`}>
          {translate('localWorkflow.audit.question', 'What should the audit find out?')}
        </Label>
        <Textarea
          id={`${id}-question`}
          rows={3}
          maxLength={32_000}
          value={draft.prompt}
          disabled={locked}
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-file`}>
            {translate('localWorkflow.audit.file', 'Records file')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'localWorkflow.audit.fileHelp',
              'An absolute path to a JSONL file on this computer. Audit runs here and checks quoted passages against this file.'
            )}
          </p>
        </div>
        <Input
          id={`${id}-file`}
          value={audit.sourceFile}
          disabled={locked}
          onChange={(event) =>
            onChange({ ...draft, audit: { ...audit, sourceFile: event.target.value } })
          }
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-format`}>
          {translate('localWorkflow.audit.format', 'File format')}
        </Label>
        <Select
          value={audit.format}
          disabled={locked}
          onValueChange={(format) => {
            if (format === 'sources-jsonl' || format === 'digests-jsonl') {
              onChange({ ...draft, audit: { ...audit, format } })
            }
          }}
        >
          <SelectTrigger id={`${id}-format`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sources-jsonl">
              {translate('localWorkflow.audit.sources', 'Dated text records')}
            </SelectItem>
            <SelectItem value="digests-jsonl">
              {translate('localWorkflow.audit.digests', 'Conversation digests')}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {audit.format === 'sources-jsonl'
            ? translate(
                'localWorkflow.audit.sourcesHelp',
                'One JSON object per line with id, timestamp (including its time zone), and text.'
              )
            : translate(
                'localWorkflow.audit.digestsHelp',
                'One JSON object per line with id, first_ts, user_msgs and assistant, using the conversation-audit digest format.'
              )}
        </p>
      </div>
      <fieldset disabled={locked} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">
          {translate('localWorkflow.audit.models', 'Models')}
        </legend>
        {entries.map(({ seat, models, checked }, index) => {
          const selectedSeat = selected.find((entry) => entry.id === seat.id)
          const value =
            selectedSeat?.model ??
            seat.model ??
            models.find((model) => model.catalog.isDefault)?.catalog.id ??
            ''
          const checkboxLabel = translate('localWorkflow.audit.useProvider', 'Use {{provider}}', {
            provider: localWorkflowProviderLabel(seat.agent)
          })
          return (
            <div key={seat.id} className="flex flex-wrap items-center gap-2">
              <Checkbox
                checked={checked}
                aria-label={checkboxLabel}
                disabled={locked || (checked && seats.length === 1)}
                onCheckedChange={(nextChecked) => {
                  const nextSeats = nextChecked
                    ? [...seats, seat]
                    : seats.filter((entry) => entry.id !== seat.id)
                  onChange({ ...draft, seats: nextSeats })
                }}
              />
              <ModelDot agent={seat.agent} model={value} />
              <Label htmlFor={`${id}-model-${index}`} className="w-28">
                {localWorkflowProviderLabel(seat.agent)}
              </Label>
              <Select
                value={value}
                disabled={locked || !checked || !models.length}
                onValueChange={(model) => {
                  onChange({
                    ...draft,
                    seats: selected.map((entry) =>
                      entry.id === seat.id ? { ...entry, model, effort: undefined } : entry
                    )
                  })
                }}
              >
                <SelectTrigger id={`${id}-model-${index}`} className="min-w-40 flex-1">
                  <SelectValue
                    placeholder={translate('localWorkflow.audit.chooseModel', 'Choose a model')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {models.map(({ catalog: model }) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))}
                  {value && !models.some((model) => model.catalog.id === value) ? (
                    <SelectItem value={value}>{value}</SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            </div>
          )
        })}
        <p className="text-xs text-muted-foreground">
          {translate(
            'localWorkflow.audit.modelHelp',
            'Separate readers, reviewers and planners use these models. You can inspect each model’s work as the audit runs.'
          )}
        </p>
      </fieldset>
      {error || (unavailableReason && !loading) ? (
        <p role="alert" className="text-sm text-destructive">
          {error || unavailableReason}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {translate('localWorkflow.setup.loading', 'Checking which models are available…')}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {translate('localWorkflow.audit.local', 'Runs on this computer.')}
        </p>
        <Button
          type="submit"
          size="sm"
          disabled={!ready || starting || loading || !!unavailableReason}
        >
          <Play aria-hidden="true" className="size-3.5" />
          {recoveringStart
            ? translate('localWorkflow.audit.retryStart', 'Retry Start')
            : translate('localWorkflow.audit.run', 'Run Audit')}
        </Button>
      </div>
    </form>
  )
}
