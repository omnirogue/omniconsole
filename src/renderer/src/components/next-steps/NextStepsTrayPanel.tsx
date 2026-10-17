import { useRef, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  NextStepSuggestion,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'
import type { NextStepDoneness } from '../../../../shared/next-step-doneness'
import { NextStepRow } from './NextStepRow'
import { NextStepsDonenessChip } from './NextStepsDonenessChip'

export type NextStepsTrayActions = {
  /** Every answer goes to the host; a throw is shown by the tray, the rows stay. */
  run: (set: NextStepSuggestionSet, chosen: readonly NextStepSuggestion[]) => Promise<void>
  save: (set: NextStepSuggestionSet, chosen: readonly NextStepSuggestion[]) => Promise<void>
  dismiss: (set: NextStepSuggestionSet) => Promise<void>
  suggest: (again?: boolean) => Promise<void>
}

export function NextStepsThinkingLine() {
  return (
    <p className="text-xs text-muted-foreground" role="status">
      {translate('nextSteps.thinking', 'Thinking of next steps…')}
    </p>
  )
}

export function NextStepsFailureLine({ reason }: { reason: string }) {
  const shown =
    reason.trim() || translate('nextSteps.failedNoReason', 'Suggestions could not be generated.')
  return (
    <p className="truncate text-xs text-muted-foreground" title={shown}>
      {translate('nextSteps.failed', 'No AI suggestions: {{reason}}', { reason: shown })}
    </p>
  )
}

/** The rows of one set, with the person's answers to it. */
export function NextStepsTrayPanel({
  set,
  suggestions,
  thinking,
  failure,
  suggesting,
  actions,
  onError,
  headerControl,
  onTick,
  title,
  doneness,
  choose
}: {
  set: NextStepSuggestionSet
  suggestions: readonly NextStepSuggestion[]
  thinking: boolean
  failure: string | null
  suggesting: boolean
  actions: NextStepsTrayActions
  onError: (message: string) => void
  /** Sits in the header beside "Suggest next steps", e.g. the "Keep going" switch. */
  headerControl?: React.ReactNode
  /** Ticking a row is the person acting on the set. */
  onTick?: () => void
  /** Heading; "Suggested next steps" unless the surface names its own. */
  title?: string
  /** JEV's reading for this turn; a chip shows only when it is clear. */
  doneness?: NextStepDoneness | null
  /**
   * The reply offered these rows as one menu: the options it named start ticked, and the primary
   * answer is "Build selected", which the host sends as one message.
   */
  choose?: { preselectedIds: readonly string[] }
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(choose?.preselectedIds ?? [])
  )
  const [pending, setPending] = useState(false)
  const safe = suggestions.filter((suggestion) => suggestion.risk === 'safe')
  // Why set order, not click order: suggestions are ranked, and the queue keeps that order.
  const ticked = suggestions.filter((suggestion) => selected.has(suggestion.id))
  const busy = pending || suggesting

  // Why a ref: two clicks in one frame both see the state from before the first one.
  const inFlight = useRef(false)
  const answer = async (work: () => Promise<void>): Promise<void> => {
    if (inFlight.current || busy) {
      return
    }
    inFlight.current = true
    setPending(true)
    try {
      await work()
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  const toggle = (id: string, checked: boolean): void => {
    onTick?.()
    setSelected((previous) => {
      const next = new Set(previous)
      if (checked) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return next
    })
  }

  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-2 text-xs font-medium">
        <span>{title ?? translate('nextSteps.title', 'Suggested next steps')}</span>
        <span className="text-muted-foreground">{suggestions.length}</span>
        <NextStepsDonenessChip reading={doneness} />
        {headerControl ? <span className="ml-auto">{headerControl}</span> : null}
        <Button
          size="icon-xs"
          variant="ghost"
          className={headerControl ? undefined : 'ml-auto'}
          disabled={busy || thinking}
          aria-label={translate('nextSteps.suggestAgain', 'Suggest again')}
          title={translate('nextSteps.suggestAgain', 'Suggest again')}
          onClick={() => void answer(() => actions.suggest(true))}
        >
          <Sparkles />
        </Button>
      </div>
      {thinking || failure !== null ? (
        <div className="px-3 pt-1">
          {thinking ? <NextStepsThinkingLine /> : <NextStepsFailureLine reason={failure ?? ''} />}
        </div>
      ) : null}
      <ul className="max-h-64 overflow-y-auto scrollbar-sleek px-3 py-1">
        {suggestions.map((suggestion) => (
          <NextStepRow
            key={suggestion.id}
            suggestion={suggestion}
            origin={set.origin}
            checked={selected.has(suggestion.id)}
            disabled={busy}
            onCheckedChange={(checked) => toggle(suggestion.id, checked)}
            onRun={() => void answer(() => actions.run(set, [suggestion]))}
          />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 border-t border-status-info-border px-3 py-2">
        {choose ? (
          <Button
            size="xs"
            disabled={busy || !ticked.length}
            onClick={() => void answer(() => actions.run(set, ticked))}
          >
            {translate('nextSteps.buildSelected', 'Build selected ({{n}})', { n: ticked.length })}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant={choose ? 'secondary' : 'default'}
          disabled={busy || !safe.length}
          onClick={() => void answer(() => actions.run(set, safe))}
        >
          {translate('nextSteps.runAllSafe', 'Run all safe ({{n}})', { n: safe.length })}
        </Button>
        {choose ? null : (
          <Button
            size="xs"
            variant="secondary"
            disabled={busy || !ticked.length}
            onClick={() => void answer(() => actions.run(set, ticked))}
          >
            {translate('nextSteps.runSelected', 'Run selected ({{n}})', { n: ticked.length })}
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || !ticked.length}
          onClick={() => void answer(() => actions.save(set, ticked))}
        >
          {translate('nextSteps.saveForLater', 'Save for later ({{n}})', { n: ticked.length })}
        </Button>
        {choose ? (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={busy}
            aria-label={translate('nextSteps.answer.noLabel', 'No, send nothing')}
            onClick={() => void answer(() => actions.dismiss(set))}
          >
            {translate('nextSteps.answer.no', 'No')}
          </Button>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            className="ml-auto"
            disabled={busy}
            aria-label={translate('nextSteps.dismiss', 'Dismiss suggestions')}
            onClick={() => void answer(() => actions.dismiss(set))}
          >
            <X />
          </Button>
        )}
      </div>
    </>
  )
}
