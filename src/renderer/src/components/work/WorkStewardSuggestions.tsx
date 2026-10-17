import React, { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useRuntimeRead } from '@/lib/use-organization-history'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  SESSION_STEWARD_RPC,
  type StewardGuardNotice,
  type StewardSuggestion,
  type StewardSuggestionAcceptResult,
  type StewardSuggestionsResult
} from '../../../../shared/session-steward-suggestions'
import { hasStewardSuggestionRows, stewardSuggestionRows } from './steward-suggestions-model'

type Act = (method: string, params: unknown, done?: (result: unknown) => void) => void

function pausedText(notice: StewardGuardNotice): string {
  const values = { corrected: notice.corrected, samples: notice.samples }
  return notice.feature === 'refile'
    ? translate(
        'work.steward.pausedRefile',
        'Re-filing paused: {{corrected}} of {{samples}} moves undone.',
        values
      )
    : translate(
        'work.steward.pausedRetitle',
        'Re-titling paused: {{corrected}} of {{samples}} titles undone.',
        values
      )
}

function OfferRow({
  suggestion,
  busy,
  act
}: {
  suggestion: StewardSuggestion
  busy: boolean
  act: Act
}): React.JSX.Element {
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2"
      data-steward-suggestion={suggestion.kind}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{suggestion.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {suggestion.kind === 'merge'
            ? translate('work.steward.mergeLabel', 'Merge suggestion')
            : translate('work.steward.projectLabel', 'Project suggestion')}
          {suggestion.evidence ? ` · ${suggestion.evidence}` : ''}
        </div>
      </div>
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() =>
          act(SESSION_STEWARD_RPC.acceptSuggestion, { id: suggestion.id }, (result) => {
            const summary = (result as StewardSuggestionAcceptResult | undefined)?.summary
            if (summary) {
              toast.success(summary)
            }
          })
        }
      >
        {translate('work.steward.yes', 'Yes')}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => act(SESSION_STEWARD_RPC.dismissSuggestion, { id: suggestion.id })}
      >
        {translate('work.steward.dismiss', 'Dismiss')}
      </Button>
    </li>
  )
}

/**
 * The steward's suggestions (Yes / Dismiss), accuracy-guard pauses (Resume) and the count of
 * sessions it could not place; rendered as rows of the Steward activity list.
 */
export function WorkStewardSuggestions({
  onChanged
}: {
  onChanged: () => void
}): React.JSX.Element | null {
  const { data, reload } = useRuntimeRead<StewardSuggestionsResult>(
    SESSION_STEWARD_RPC.suggestions,
    {},
    true
  )
  const rows = useMemo(() => stewardSuggestionRows(data), [data])
  const [busy, setBusy] = useState(false)
  const act: Act = (method, params, done) => {
    setBusy(true)
    callRuntimeRpc<unknown>({ kind: 'local' }, method, params)
      .then((result) => {
        done?.(result)
        onChanged()
      })
      .catch((failure: unknown) => {
        toast.error(failure instanceof Error ? failure.message : String(failure))
      })
      .finally(() => {
        setBusy(false)
        reload()
      })
  }
  if (!hasStewardSuggestionRows(rows)) {
    return null
  }
  return (
    <>
      {rows.paused.map((notice) => (
        <li
          key={notice.feature}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm"
          data-steward-paused={notice.feature}
        >
          <span className="min-w-0 flex-1">{pausedText(notice)}</span>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => act(SESSION_STEWARD_RPC.resumeOrganize, { feature: notice.feature })}
          >
            {translate('work.steward.resume', 'Resume')}
          </Button>
        </li>
      ))}
      {rows.offers.map((suggestion) => (
        <OfferRow key={suggestion.id} suggestion={suggestion} busy={busy} act={act} />
      ))}
      {rows.unplaced ? (
        <li
          className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm"
          data-steward-unplaced={rows.unplaced.count}
        >
          <span className="min-w-0 flex-1">
            {rows.unplaced.count === 1
              ? translate(
                  'work.steward.unplacedOne',
                  '1 session could not be placed in a folder; file it from the sidebar.'
                )
              : translate(
                  'work.steward.unplacedMany',
                  '{{count}} sessions could not be placed in a folder; file them from the sidebar.',
                  { count: rows.unplaced.count }
                )}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              rows.unplaced && act(SESSION_STEWARD_RPC.dismissSuggestion, { id: rows.unplaced.id })
            }
          >
            {translate('work.steward.dismiss', 'Dismiss')}
          </Button>
        </li>
      ) : null}
    </>
  )
}
