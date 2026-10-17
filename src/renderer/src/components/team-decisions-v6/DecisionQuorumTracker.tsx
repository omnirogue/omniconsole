import { useId } from 'react'
import {
  ArrowRightLeft,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  UserRound,
  Users
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

type QuorumPerson = { id: string; name: string }

export type DecisionQuorumAuthority = {
  role: string
  canVote: boolean | null
  canDelegate: boolean | null
  reason?: string
}

export type DecisionQuorumVoter = QuorumPerson & {
  role: string
  vote: {
    choice: string
    castBy: QuorumPerson
    castAt?: string
    // Quorum credit comes from the decision service, never from a role or choice label.
    countsTowardQuorum: boolean
  } | null
  delegation?: {
    delegate: QuorumPerson
    status: 'active' | 'revoked' | 'expired'
  }
}

export type DecisionQuorumTrackerProps = {
  decisionId: string
  title?: string
  /** One current record per voter seat, including pending voters. */
  voters: readonly DecisionQuorumVoter[]
  /** Server-resolved permissions for the current viewer. Null means unresolved. */
  authority: DecisionQuorumAuthority
  updateState: 'live' | 'reconnecting' | 'offline'
  className?: string
} & ({ mode: 'one-to-one'; requiredVotes?: never } | { mode: 'one-to-many'; requiredVotes: number })

function AuthorityIndicator({ authority }: { authority: DecisionQuorumAuthority }) {
  const Icon =
    authority.canVote === null ? ShieldQuestion : authority.canVote ? ShieldCheck : ShieldX
  const voteLabel =
    authority.canVote === null
      ? 'Voting authority unverified'
      : authority.canVote
        ? 'Authorized to vote'
        : 'Voting restricted'
  const delegationLabel =
    authority.canDelegate === null
      ? 'Delegation authority unverified'
      : authority.canDelegate
        ? 'May delegate'
        : 'Cannot delegate'

  return (
    <div className="space-y-1 border-t border-border pt-3 text-xs" aria-label="Your RBAC authority">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Your authority</span>
        <Badge variant="outline" className="max-w-full whitespace-normal break-words">
          <Icon aria-hidden="true" />
          {authority.role || 'Role unavailable'} · {voteLabel}
        </Badge>
        <span className="text-muted-foreground">{delegationLabel}</span>
      </div>
      {authority.reason && <p className="break-words text-muted-foreground">{authority.reason}</p>}
    </div>
  )
}

function VoteTime({ value }: { value?: string }) {
  if (!value) {
    return null
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return null
  }
  return <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
}

function VoterRow({ voter }: { voter: DecisionQuorumVoter }) {
  const { vote, delegation } = voter
  return (
    <li className="space-y-1.5 py-3" data-voter-id={voter.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 break-words">
          <p className="text-sm font-medium">{voter.name || voter.id}</p>
          <p className="text-xs text-muted-foreground">{voter.role || 'Role unavailable'}</p>
        </div>
        <Badge variant="secondary" className="max-w-full whitespace-normal break-words">
          {vote ? vote.choice : 'Awaiting vote'}
        </Badge>
      </div>
      {delegation && (
        <Badge variant="outline" className="max-w-full whitespace-normal break-words">
          <ArrowRightLeft aria-hidden="true" />
          {delegation.status === 'active'
            ? 'Delegated to'
            : `Delegation ${delegation.status}:`}{' '}
          {delegation.delegate.name || delegation.delegate.id}
        </Badge>
      )}
      {vote && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 break-words text-xs text-muted-foreground">
          <span>Cast by {vote.castBy.name || vote.castBy.id}</span>
          <span>
            {vote.countsTowardQuorum ? 'Counts toward quorum' : 'Not counted toward quorum'}
          </span>
          <VoteTime value={vote.castAt} />
        </div>
      )}
    </li>
  )
}

/** Controlled display: the owner supplies fresh snapshots from the decision's execution host. */
export function DecisionQuorumTracker(props: DecisionQuorumTrackerProps) {
  const {
    decisionId,
    title = 'Decision quorum',
    voters,
    authority,
    updateState,
    className,
    mode
  } = props
  const headingId = useId()
  const summaryId = useId()
  const required = mode === 'one-to-one' ? 1 : props.requiredVotes
  const uniqueVoters = new Map(voters.map((voter) => [voter.id, voter]))
  const rows = Array.from(uniqueVoters.values())
  const invalidThreshold = !Number.isSafeInteger(required) || required < 1
  let issue: string | null = null
  if (invalidThreshold) {
    issue = 'Set a positive whole-number quorum requirement.'
  } else if (uniqueVoters.size !== voters.length || rows.some((voter) => !voter.id.trim())) {
    issue = 'Voter records need unique, non-empty IDs before quorum can be calculated.'
  } else if (mode === 'one-to-one' && rows.length > 1) {
    issue = 'A 1-to-1 decision requires exactly one voter.'
  } else if (rows.length > 0 && required > rows.length) {
    issue = 'The quorum requirement exceeds the number of assigned voters.'
  }
  const counted = rows.filter((voter) => voter.vote?.countsTowardQuorum === true).length
  const pending = rows.filter((voter) => voter.vote === null).length
  const met = !issue && counted >= required
  const percentage = issue ? null : Math.min(100, (counted / required) * 100)
  const ModeIcon = mode === 'one-to-one' ? UserRound : Users
  const freshnessLabel =
    updateState === 'live'
      ? 'Live updates'
      : updateState === 'reconnecting'
        ? 'Reconnecting'
        : 'Offline'
  const quorumLabel = issue ? 'Quorum unavailable' : met ? 'Quorum met' : 'Awaiting quorum'
  const summary = issue
    ? 'Quorum progress unavailable'
    : `${counted} of ${required} required votes counted · ${pending} pending`

  return (
    <section
      aria-labelledby={headingId}
      data-decision-id={decisionId}
      className={cn(
        'min-w-0 space-y-3 rounded-lg border border-border bg-card p-4 text-card-foreground',
        className
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 id={headingId} className="break-words text-sm font-semibold">
            {title}
          </h3>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ModeIcon className="size-3.5" aria-hidden="true" />
            {mode === 'one-to-one' ? '1-to-1 decision' : '1-to-many decision'}
          </p>
        </div>
        <Badge variant="outline">{freshnessLabel}</Badge>
      </div>

      <div className="space-y-2">
        <div role="status" aria-live="polite" aria-atomic="true" className="space-y-1">
          <p
            className={cn(
              'text-sm font-medium',
              met && updateState === 'live' && 'text-status-success'
            )}
          >
            {updateState === 'live' ? quorumLabel : `Last known: ${quorumLabel.toLowerCase()}`}
          </p>
          <p id={summaryId} className="text-xs text-muted-foreground">
            {summary}
          </p>
          {updateState !== 'live' && (
            <p className="text-xs text-status-warning">
              {updateState === 'reconnecting'
                ? 'Reconnecting to decision updates.'
                : 'Decision updates are offline.'}{' '}
              Votes and permissions may have changed.
            </p>
          )}
        </div>
        <Progress
          value={percentage}
          aria-label="Quorum progress"
          aria-describedby={summaryId}
          aria-valuetext={summary}
          className="bg-muted motion-reduce:[&_[data-slot=progress-indicator]]:transition-none"
        />
        {issue && (
          <p role="alert" className="text-xs text-destructive">
            {issue}
          </p>
        )}
        {met && (
          <p className="text-xs text-muted-foreground">
            Quorum does not determine the decision outcome.
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          Assign voters to begin tracking quorum.
        </p>
      ) : (
        <ul
          aria-label="Voter attribution"
          className="max-h-72 divide-y divide-border overflow-y-auto scrollbar-sleek"
        >
          {rows.map((voter) => (
            <VoterRow key={voter.id} voter={voter} />
          ))}
        </ul>
      )}
      <AuthorityIndicator authority={authority} />
    </section>
  )
}
