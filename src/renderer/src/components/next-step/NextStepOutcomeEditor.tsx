import { useEffect, useRef, useState } from 'react'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type { SessionFinishAction } from '@/lib/session-folders'
import type { OrgChartPerson } from '../../../../shared/console-companies-contract'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import type {
  NextStepDraft,
  NextStepHandoffOptions,
  NextStepOutcomeDraft
} from '../../../../shared/next-step-draft'
import { NextStepOutcomeAgents } from './NextStepOutcomeAgents'
import { SessionTeamPlanPreview } from '@/components/session-team/SessionTeamPlanPreview'
import { useSessionSourceActor } from '@/components/session-team/use-session-source-actor'
import { NextStepOutcomeFacts } from './NextStepOutcomeFacts'
import { NextStepOutcomeNextPerson } from './NextStepOutcomeNextPerson'
import { NEXT_STEP_PACKAGE_MAX_FILES } from './NextStepOutcomePackage'
import { mergeSessionFiles, useSessionChangedFiles } from './next-step-session-changes'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { NextStepOutcomeSwitcher } from './NextStepOutcomeSwitcher'
import { SessionFinishFields } from './SessionFinishFields'
import type { NextStepOutcomeFacts as Facts } from './next-step-outcome-facts'
import { defaultNextStepOutcomeDraft, withDefaultFinish } from './next-step-outcome-sections'
import type { NextStepRecipientSource } from './use-next-step-recipients'

type NextStepOutcomeEditorProps = {
  draft: NextStepDraft
  onChange: (draft: NextStepDraft) => void
  agents: AgentCatalogEntry[]
  people: readonly TeamRosterPerson[]
  recipientSource?: Pick<NextStepRecipientSource, 'people' | 'reload'>
  orgPeople?: readonly OrgChartPerson[]
  worktreeSelector: string | null
  /** Session facts for the right column; without them only the three questions render. */
  facts?: Facts
  /** Whether the session's history source is settled, so a when-done handoff can carry it. */
  historyAvailable?: boolean
  chain?: SessionChain | null
  onChainChanged?: (chain: SessionChain) => void
  onError?: (message: string) => void
  sessionFinish: SessionFinishAction
  onSessionFinishChange: (value: SessionFinishAction) => void
  timing?: 'now' | 'done'
  onTimingChange?: (timing: 'now' | 'done') => void
}

/**
 * The three questions on the left — which agents → which person → what happens to this
 * session — and the facts at a glance on the right. Untouched, every answer is already the
 * default, so the primary button is the only click the common path needs; everything else
 * opens on hover.
 */
export function NextStepOutcomeEditor({
  draft,
  onChange,
  agents,
  people,
  recipientSource,
  orgPeople,
  worktreeSelector,
  facts,
  historyAvailable = false,
  chain = null,
  onChainChanged,
  onError,
  sessionFinish,
  onSessionFinishChange,
  timing,
  onTimingChange
}: NextStepOutcomeEditorProps): React.JSX.Element {
  const outcomes = draft.outcomes?.length ? draft.outcomes : [defaultNextStepOutcomeDraft()]
  const [selected, setSelected] = useState(0)
  const index = Math.min(selected, outcomes.length - 1)
  const outcome = withDefaultFinish(outcomes[index]!)
  const replaceOutcome = (next: NextStepOutcomeDraft): void =>
    onChange({
      ...draft,
      outcomes: outcomes.map((entry, current) => (current === index ? next : entry))
    })
  const removeOutcome = (at: number, reason?: string): void => {
    const remaining = outcomes.filter((_, current) => current !== at)
    const removed = outcomes[at]!
    onChange({
      ...draft,
      outcomes: remaining.length ? remaining : [defaultNextStepOutcomeDraft()],
      outcomeRemovals:
        removed.revision && reason
          ? [...(draft.outcomeRemovals ?? []), { outcomeId: removed.id, reason }]
          : draft.outcomeRemovals
    })
    setSelected(Math.max(0, Math.min(at, remaining.length - 1)))
  }
  const patchHandoff = (patch: Partial<NextStepHandoffOptions>): void =>
    onChange({ ...draft, handoff: { ...draft.handoff, ...patch } })
  // Why: the package starts with what the session produced, not an empty file chooser. The
  // workspace's changed files are read once a person is chosen; a run's manifest wins when the
  // session has one; anything the person added stays across a later look.
  const personChosen = outcome.finish?.kind === 'person' && Boolean(outcome.finish.personId)
  const autoFiles = useSessionChangedFiles(
    facts
      ? {
          worktreeId: facts.session.worktreeId,
          hostId: (facts.session.hostId as ExecutionHostId | undefined) ?? null,
          workspacePath: facts.workspacePath
        }
      : null,
    NEXT_STEP_PACKAGE_MAX_FILES,
    personChosen && !!facts && !facts.defaultDeliverables
  )
  const source = useSessionSourceActor(facts?.session ?? null)
  const appliedDetected = useRef<string[] | null>(null)
  const detected = autoFiles.detected
  useEffect(() => {
    if (!personChosen || !facts) {
      return
    }
    const { deliverables } = draft.handoff
    if (!deliverables && facts.defaultDeliverables) {
      patchHandoff({ deliverables: facts.defaultDeliverables })
      return
    }
    if (!detected || (deliverables && deliverables.kind !== 'files')) {
      return
    }
    const previous = appliedDetected.current
    if (previous && previous.join('\n') === detected.paths.join('\n')) {
      return
    }
    appliedDetected.current = detected.paths
    const merged = mergeSessionFiles({
      detected: detected.paths,
      current: deliverables?.paths ?? [],
      previousDetected: previous ?? [],
      limit: NEXT_STEP_PACKAGE_MAX_FILES
    })
    if (merged.length) {
      patchHandoff({ deliverables: { kind: 'files', paths: merged } })
    }
    // Why: only a new detection or a newly chosen person may rewrite the package.
  }, [personChosen, detected]) // eslint-disable-line react-hooks/exhaustive-deps
  const questions = (
    <div className="min-w-0 space-y-4">
      <NextStepOutcomeAgents
        outcome={outcome}
        agents={agents}
        worktreeSelector={worktreeSelector}
        onChange={replaceOutcome}
      />
      {outcome.steps.length > 0 ? (
        <SessionTeamPlanPreview draft={draft} source={source} cardlessHandoffs />
      ) : null}
      <NextStepOutcomeNextPerson
        outcome={outcome}
        people={people}
        orgPeople={orgPeople}
        recipientSource={recipientSource}
        timing={timing}
        onTimingChange={onTimingChange}
        onChange={replaceOutcome}
        pack={
          facts
            ? {
                facts,
                handoff: draft.handoff,
                onHandoffChange: patchHandoff,
                historyAvailable,
                ...(facts.defaultDeliverables ? {} : { autoFiles })
              }
            : undefined
        }
      />
      {timing !== 'now' ? (
        <SessionFinishFields value={sessionFinish} onChange={onSessionFinishChange} layout="row" />
      ) : null}
    </div>
  )
  return (
    <div className="space-y-3" data-next-step-outcomes>
      {outcomes.length > 1 ? (
        <NextStepOutcomeSwitcher
          outcomes={outcomes}
          index={index}
          onIndexChange={setSelected}
          onRemove={removeOutcome}
        />
      ) : null}
      {facts ? (
        // Why: 640px is where two columns still leave each control room; below it they stack.
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
          {questions}
          <NextStepOutcomeFacts
            facts={facts}
            outcome={outcome}
            onOutcomeChange={replaceOutcome}
            handoff={draft.handoff}
            onHandoffChange={patchHandoff}
            chain={chain}
            onChainChanged={onChainChanged ?? (() => {})}
            onError={onError ?? (() => {})}
          />
        </div>
      ) : (
        questions
      )}
    </div>
  )
}
