import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { buildSessionTeamSummary } from '@/lib/session-team-summary'
import { compileNextStepChain } from '../../../../shared/next-step-compile'
import type { NextStepDraft } from '../../../../shared/next-step-draft'
import {
  sessionChainPolicyProblems,
  type SessionChainPolicyProblem,
  type SessionChainSource
} from '../../../../shared/session-chain-policy'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { SessionTeamPhaseRows } from './SessionTeamPhaseRows'

/** The chain the draft would become, unregistered and unsent, so the preview reads like the run. */
export function previewSessionChain(
  draft: NextStepDraft,
  cardlessHandoffs: boolean
): SessionChain | null {
  const { steps } = compileNextStepChain({
    draft,
    cardlessHandoffs,
    chainId: 'chn_preview',
    workspacePath: '/',
    sessionLabel: 'session',
    defaultNote: 'note',
    now: 0,
    mintStepId: (position) => `step_${position}`,
    mintOperationId: () => 'op_preview_0000'
  })
  if (steps.length === 0) {
    return null
  }
  return {
    id: 'chn_preview',
    workspacePath: '/',
    worktreeId: 'preview',
    hostId: null,
    sourcePaneKey: 'preview',
    sourceRowKey: 'preview',
    auto: false,
    steps,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 0,
    updatedAt: 0,
    ...(draft.end ? { end: draft.end } : {})
  }
}

export function PolicyProblemLines({
  problems
}: {
  problems: readonly SessionChainPolicyProblem[]
}): React.JSX.Element | null {
  if (problems.length === 0) {
    return null
  }
  return (
    <ul className="space-y-0.5 text-xs" data-session-team-policy>
      {problems.map((problem) => (
        <li
          key={`${problem.stepId}:${problem.code}`}
          data-session-team-policy-level={problem.level}
          className={cn(
            'whitespace-normal break-words',
            problem.level === 'block' ? 'text-destructive' : 'text-status-warning'
          )}
        >
          {problem.message}
        </li>
      ))}
    </ul>
  )
}

/**
 * What the draft would run, drawn before Go in the same rows the live plan fills in: seats
 * that launch together, the seats that wait on them, the exact model in every seat. The
 * estate's review rules are checked on the compiled plan and named here, not after Send.
 */
export function SessionTeamPlanPreview({
  draft,
  source,
  cardlessHandoffs = false
}: {
  draft: NextStepDraft
  /** The session the plan runs after; null when the plan starts fresh. */
  source: SessionChainSource | null
  cardlessHandoffs?: boolean
}): React.JSX.Element | null {
  const { members, problems } = useMemo(() => {
    const chain = previewSessionChain(draft, cardlessHandoffs)
    if (!chain) {
      return { members: [], problems: [] }
    }
    return {
      members: buildSessionTeamSummary({
        paneKey: null,
        entry: null,
        orchestrationChildren: [],
        chain
      }).members,
      problems: sessionChainPolicyProblems(chain, source)
    }
  }, [draft, source, cardlessHandoffs])
  if (members.length === 0) {
    return null
  }
  return (
    <div
      className="min-w-0 space-y-1.5 rounded-md border border-border/60 p-2"
      data-session-team-preview
    >
      <p className="text-xs text-muted-foreground">
        {translate('sessionTeam.previewTitle', 'What runs, in order')}
      </p>
      <SessionTeamPhaseRows members={members} />
      <PolicyProblemLines problems={problems} />
    </div>
  )
}
