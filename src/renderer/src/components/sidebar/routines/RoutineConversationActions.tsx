import { useEffect, useState } from 'react'
import { AutomationRunActions } from '@/components/automations/AutomationRunActions'
import { listAutomationRunsForTarget } from '@/components/automations/automation-host-client'
import {
  getAutomationRunMessage,
  isAutomationApplyRun
} from '@/components/automations/automation-run-content'
import { AUTOMATIONS_CHANGED_EVENT } from '@/lib/automations-changed-window-event'
import { translate } from '@/i18n/i18n'
import type { AutomationRun } from '../../../../../shared/automations-types'
import type { RoutineSessionOwner } from '@/lib/routine-backed-session'
import { ownerKey } from '../../../../../shared/automation-owner-key'
import { RoutineConversationResultPanel } from './RoutineConversationResultPanel'
import {
  readStructuredRoutineConversation,
  type StructuredRoutineConversation
} from './structured-routine-conversation'

/**
 * Why here: the Routines tab opens a routine's live conversation, not the run page under Routine
 * settings, so the recommended actions of the newest report have to sit above that conversation
 * or a person never meets them where they actually read the routine (Sal, 2026-09-19).
 */
export function RoutineConversationActions({ routine }: { routine: RoutineSessionOwner }) {
  if (routine.automation.structuredOutput?.provider === 'typesafe') {
    const identity = [
      routine.automation.id,
      String(routine.automation.updatedAt),
      routine.sourceTarget.kind,
      routine.sourceTarget.kind === 'environment' ? routine.sourceTarget.environmentId : '',
      routine.ownerRef ? ownerKey(routine.ownerRef) : 'uncaptured'
    ]
      .map(encodeURIComponent)
      .join('|')
    return (
      <RoutineConversationResultPanel>
        <StructuredConversationActions key={identity} routine={routine} />
      </RoutineConversationResultPanel>
    )
  }
  return <LegacyConversationActions routine={routine} />
}

function LegacyConversationActions({ routine }: { routine: RoutineSessionOwner }) {
  const { automation, sourceTarget } = routine
  const [runs, setRuns] = useState<AutomationRun[]>([])
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void listAutomationRunsForTarget(sourceTarget, automation.id)
        .then((next) => {
          if (!cancelled) {
            setRuns(next)
          }
        })
        .catch(() => {
          // A failed history read leaves the card as it was; the next change event retries.
        })
    }
    load()
    window.addEventListener(AUTOMATIONS_CHANGED_EVENT, load)
    return () => {
      cancelled = true
      window.removeEventListener(AUTOMATIONS_CHANGED_EVENT, load)
    }
  }, [automation.id, sourceTarget])
  const latest = latestRunWithActions(runs)
  if (!latest) {
    return null
  }
  return (
    <div className="border-b px-3 pt-3" data-routine-conversation-actions>
      <AutomationRunActions
        automation={automation}
        run={latest}
        runs={runs}
        runNowAvailability={null}
        sourceTarget={sourceTarget}
      />
    </div>
  )
}

type StructuredHistoryState =
  | { status: 'loading' | 'unavailable' }
  | { status: 'loaded'; history: StructuredRoutineConversation }

function StructuredConversationActions({ routine }: { routine: RoutineSessionOwner }) {
  const { automation, sourceTarget, ownerRef } = routine
  const [state, setState] = useState<StructuredHistoryState>({ status: 'loading' })
  useEffect(() => {
    let disposed = false
    let request = 0
    let pending: AbortController | undefined
    const load = (): void => {
      const current = ++request
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      setState({ status: 'loading' })
      void readStructuredRoutineConversation(automation, sourceTarget, controller.signal, ownerRef)
        .then((history) => {
          if (!disposed && current === request) {
            setState({ status: 'loaded', history })
          }
        })
        .catch(() => {
          if (!disposed && current === request) {
            setState({ status: 'unavailable' })
          }
        })
    }
    load()
    window.addEventListener(AUTOMATIONS_CHANGED_EVENT, load)
    return () => {
      disposed = true
      pending?.abort()
      window.removeEventListener(AUTOMATIONS_CHANGED_EVENT, load)
    }
  }, [automation, sourceTarget, ownerRef])

  const history = state.status === 'loaded' ? state.history : null
  const latest = history ? latestRunWithActions(history.runs, true) : null
  return (
    <div className="border-b px-3 pt-3" data-routine-conversation-actions>
      {history && latest ? (
        <AutomationRunActions
          automation={automation}
          run={latest}
          runs={history.runs}
          runNowAvailability={null}
          sourceTarget={history.sourceTarget}
          ownerRef={history.ownerRef}
        />
      ) : (
        <p
          role={state.status === 'unavailable' ? 'alert' : 'status'}
          className="mb-3 text-xs text-muted-foreground"
        >
          {state.status === 'loading'
            ? translate('routines.structured.loading', 'Loading routine results…')
            : state.status === 'unavailable'
              ? translate(
                  'routines.structured.unavailable',
                  'Routine results are unavailable from the owning host.'
                )
              : translate('routines.structured.empty', 'This routine has no completed report yet.')}
        </p>
      )}
    </div>
  )
}

/**
 * Native results use the newest completed non-apply run. Legacy recommendations also
 * require readable report text; a newer report without actions clears older recommendations.
 */
export function latestRunWithActions(
  runs: readonly AutomationRun[],
  typesafe = false
): AutomationRun | null {
  const completed = runs
    .filter((run) => run.status === 'completed' && (typesafe || run.outputSnapshot?.content))
    .sort((left, right) => right.createdAt - left.createdAt)
  for (const run of completed) {
    if (isAutomationApplyRun(run)) {
      continue
    }
    // Native results belong to the completed run, independently of its readable transcript.
    if (typesafe) {
      return run
    }
    const message = getAutomationRunMessage(run)
    if (message.scraped) {
      continue
    }
    // The newest readable ordinary report decides: its actions, or nothing to act on.
    return message.actions.length > 0 ? run : null
  }
  return null
}
