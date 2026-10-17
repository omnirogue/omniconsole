import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { outcomeOwnerKey } from '@/lib/session-outcome-owner'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { sessionOutcomeActionKey } from '../../../../shared/session-outcome-types'
import { getOutcomeProgress, resumeSessionOutcomes } from './next-step-outcome-client'

function canResume(chain: SessionChain): boolean {
  const set = chain.outcomeSet
  if (
    !set ||
    set.continuation?.state !== 'owned' ||
    set.continuation.sourceReady !== true ||
    chain.state === 'cancelled' ||
    // Resume is a whole-set host operation. Keep this action-recovery control out
    // of sets where it could also restart a workflow, publication or handoff.
    chain.steps.some((step) => step.kind === 'handoff') ||
    set.outcomes.some(
      (outcome) =>
        outcome.finish === 'human-handoff' ||
        outcome.conditions.some((condition) => condition.kind === 'handoff')
    ) ||
    set.publications?.some((publication) => publication.state !== 'merged') ||
    set.attempts.some(
      (attempt) =>
        attempt.state === 'unverifiable' ||
        (attempt.state === 'blocked' && attempt.launchDisposition !== 'not-started')
    ) ||
    [set.workflow, ...(set.workflowHistory ?? [])].some((workflow) => workflow && !workflow.retired)
  ) {
    return false
  }
  return set.outcomes.some(
    (outcome) =>
      outcome.status === 'blocked' &&
      outcome.actions.some((action) => {
        const latest = set.attempts.findLast(
          (attempt) => attempt.outcomeId === outcome.id && attempt.actionId === action.id
        )
        return (
          latest?.state === 'blocked' &&
          latest.launchDisposition === 'not-started' &&
          latest.outcomeRevision === outcome.revision &&
          latest.actionKey === sessionOutcomeActionKey(action)
        )
      })
  )
}

export function OutcomeResumeAction({
  chain,
  onChanged,
  onError
}: {
  chain: SessionChain
  onChanged: (chain: SessionChain) => void
  onError: (error: string) => void
}): React.JSX.Element | null {
  const pending = useRef(false)
  const mounted = useRef(true)
  const current = useRef(chain)
  // Written after commit, not during render: the resume handler reads this once its
  // request returns, to check the chain it started on is still the one shown. A render
  // React replayed or discarded would otherwise let it accept a result for another chain.
  useEffect(() => {
    current.current = chain
  })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  if (!canResume(chain)) {
    return null
  }
  const resume = async (): Promise<void> => {
    if (pending.current) {
      return
    }
    pending.current = true
    setBusy(true)
    onError('')
    const revision = chain.outcomeSet!.revision
    let owner: string | undefined
    const isCurrent = (): boolean => {
      if (
        !mounted.current ||
        current.current.id !== chain.id ||
        current.current.outcomeSet?.revision !== revision
      ) {
        return false
      }
      try {
        return owner === undefined
          ? current.current === chain
          : outcomeOwnerKey(current.current) === owner
      } catch {
        return false
      }
    }
    try {
      owner = outcomeOwnerKey(chain)
      const resumed = await resumeSessionOutcomes({
        id: chain.id,
        owner: chain,
        expectedRevision: revision
      })
      if (!isCurrent()) {
        return
      }
      // Both updates come from the owning host. A successful request means
      // eligible work is queued; only fresh progress can establish execution.
      onChanged(resumed)
      const progress = await getOutcomeProgress(chain.id, chain)
      if (isCurrent()) {
        onChanged(progress.chain)
      }
    } catch (cause) {
      if (isCurrent()) {
        onError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      pending.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">
        {translate('nextStep.savedWorkNotStarted', 'The saved action has not started.')}
      </span>
      <Button
        type="button"
        size="xs"
        variant="secondary"
        disabled={busy}
        onClick={() => void resume()}
      >
        {busy
          ? translate('nextStep.resumingSavedWork', 'Resuming…')
          : translate('nextStep.resumeSavedWork', 'Resume saved work')}
      </Button>
    </div>
  )
}
