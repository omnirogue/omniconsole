import type { ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import type {
  MissionProgressItem,
  MissionProgressState,
  SessionMissionProgress
} from '../../../../shared/session-mission-progress'

export function missionStateLabel(state: MissionProgressState): string {
  switch (state) {
    case 'not-started':
      return translate('missionProgress.notStarted', 'Not started')
    case 'working':
      return translate('missionProgress.working', 'Working')
    case 'verifying':
      return translate('missionProgress.verifying', 'Verifying')
    case 'verified':
      return translate('missionProgress.verified', 'Verified')
    case 'blocked':
      return translate('missionProgress.blocked', 'Blocked')
    case 'rework':
      return translate('missionProgress.rework', 'Rework')
  }
}

function StateMark({ state }: { state: MissionProgressState }): React.JSX.Element {
  const mark = {
    'not-started': '○',
    working: '●',
    verifying: '◐',
    verified: '✓',
    blocked: '!',
    rework: '↻'
  }[state]
  return (
    <span
      className="inline-flex w-4 shrink-0 justify-center"
      role="img"
      aria-label={missionStateLabel(state)}
    >
      {mark}
    </span>
  )
}

function Deliverable({
  item,
  current
}: {
  item: MissionProgressItem
  current: boolean
}): React.JSX.Element {
  const row = (
    <>
      <StateMark state={item.state} />
      <span className="min-w-0 flex-1 truncate" title={item.title}>
        {item.ordinal}. {item.title}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {item.pullRequest
          ? `#${item.pullRequest.number}`
          : item.basis === 'unconfirmed'
            ? translate('missionProgress.unconfirmed', 'Unconfirmed')
            : missionStateLabel(item.state)}
      </span>
    </>
  )
  return (
    <li data-mission-deliverable={item.id} data-mission-state={item.state}>
      {current || item.criteria.length > 0 ? (
        <details>
          <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            {row}
          </summary>
          <div className="mt-2 space-y-1 border-l pl-4 ml-2">
            <p className="text-muted-foreground">{item.description}</p>
            {item.criteria.length > 0 ? (
              item.criteria.map((criterion) => (
                <p key={criterion.id} className="flex gap-2">
                  <StateMark state={criterion.state} />
                  <span>{criterion.title}</span>
                </p>
              ))
            ) : (
              <p className="text-muted-foreground">
                {translate(
                  'missionProgress.noCriteria',
                  'Completion criteria not linked yet; work is not verified.'
                )}
              </p>
            )}
          </div>
        </details>
      ) : (
        <div className="flex items-center gap-2">{row}</div>
      )}
    </li>
  )
}

/** Mission and verified progress stay visible; artifacts and runtime details are disclosures. */
export function SessionMissionCard({
  progress,
  evidence,
  metadata,
  screenshots = 0
}: {
  progress: SessionMissionProgress
  evidence?: ReactNode
  metadata?: ReactNode
  screenshots?: number
}): React.JSX.Element {
  return (
    <section
      className="space-y-3 text-xs"
      data-session-mission-card=""
      aria-label={translate('missionProgress.mission', 'Mission progress')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-sm" data-mission-title="">
            {progress.mission.title}
          </p>
          {progress.mission.summary ? (
            <details className="mt-1 text-muted-foreground">
              <summary className="cursor-pointer">
                {translate('missionProgress.originalRequest', 'Original mission')}
              </summary>
              <p className="mt-1">{progress.mission.summary}</p>
            </details>
          ) : null}
        </div>
        <span
          className="shrink-0 tabular-nums"
          data-mission-verified-count=""
          title={translate(
            'missionProgress.verifiedHelp',
            'Only completion criteria backed by current verification receipts count.'
          )}
        >
          {translate('missionProgress.verifiedCount', '{{done}} / {{total}} verified', {
            done: progress.verified,
            total: progress.items.length
          })}
        </span>
      </div>
      <div data-mission-current="" className="min-w-0">
        {progress.current ? (
          <>
            <p className="font-medium">{progress.current.title}</p>
            <p className="truncate text-muted-foreground" title={progress.current.activity}>
              {progress.current.activity}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            {translate('missionProgress.noCurrent', 'Current activity not confirmed')}
          </p>
        )}
      </div>
      <ol
        className="space-y-2"
        aria-label={translate('missionProgress.deliverables', 'Mission deliverables')}
      >
        {progress.items.map((item) => (
          <Deliverable key={item.id} item={item} current={progress.current?.id === item.id} />
        ))}
      </ol>
      {progress.attention.length > 0 ? (
        <ul
          className="space-y-1 border-t pt-2"
          aria-label={translate('missionProgress.attention', 'Attention')}
          data-mission-attention=""
        >
          {progress.attention.map((item) => (
            <li key={item.key} className="flex gap-2" data-attention-owner={item.owner}>
              <span aria-hidden>!</span>
              <span>
                {item.owner === 'you'
                  ? translate('missionProgress.needsYou', 'Needs You')
                  : item.owner === 'waiting'
                    ? translate('missionProgress.waiting', 'Waiting')
                    : translate('missionProgress.agentResolving', 'Agent can resolve')}{' '}
                · {item.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <details className="border-t pt-2 text-muted-foreground" data-mission-evidence="">
        <summary className="cursor-pointer">
          {translate(
            'missionProgress.evidenceSummary',
            'Evidence: {{prs}} PRs · {{receipts}} verified criteria · {{checks}} PRs checks passing',
            {
              prs: progress.evidence.pullRequests,
              receipts: progress.evidence.receipts,
              checks: progress.evidence.checksPassing
            }
          )}
          {screenshots > 0
            ? ` · ${translate('missionProgress.screenshots', '{{count}} images', { count: screenshots })}`
            : null}
        </summary>
        <div className="mt-2 space-y-2">
          {progress.items.flatMap((item) =>
            item.receipts.map((receipt) => (
              <p key={receipt.id} className="break-words">
                {receipt.receipt}
              </p>
            ))
          )}
          {evidence}
        </div>
      </details>
      {metadata ? (
        <details className="text-muted-foreground" data-mission-metadata="">
          <summary className="cursor-pointer">
            {translate('missionProgress.details', 'Session details')}
          </summary>
          <div className="mt-2">{metadata}</div>
        </details>
      ) : null}
    </section>
  )
}
