import { translate } from '@/i18n/i18n'
import type { EvolveRunRecord } from '../../../../shared/evolve-workflow'
import type { EvolveHostedProgressEntry } from '../../../../shared/evolve-hosted-progress'
import { evolveScore, evolveTime } from './evolve-run-text'

function shortId(candidateId: string | undefined): string {
  return candidateId ? candidateId.slice(0, 8) : '?'
}

function entryText(entry: EvolveHostedProgressEntry): string {
  const vars = {
    candidate: shortId(entry.candidateId),
    score: evolveScore(entry.score),
    generation: entry.generation ?? '?'
  }
  switch (entry.kind) {
    case 'evaluated':
      return translate(
        'evolveHosted.progress.evaluated',
        'Candidate {{candidate}} scored {{score}} (generation {{generation}})',
        vars
      )
    case 'eliminated':
      return translate(
        'evolveHosted.progress.eliminated',
        'Candidate {{candidate}} knocked out at {{score}} (generation {{generation}})',
        vars
      )
    case 'frontier':
      return translate(
        'evolveHosted.progress.frontier',
        'New leader: candidate {{candidate}} at {{score}}',
        vars
      )
    case 'promoted':
      return translate('evolveHosted.progress.promoted', 'Candidate {{candidate}} promoted', vars)
    case 'rolled_back':
      return translate(
        'evolveHosted.progress.rolledBack',
        'Candidate {{candidate}} rolled back',
        vars
      )
    case 'budget':
      return translate('evolveHosted.progress.budget', 'Credit budget used up')
    case 'lease':
      return translate('evolveHosted.progress.lease', 'Cloud worker restarted the run')
  }
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border bg-muted/30 px-2.5 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  )
}

/** Live candidate and knockout progress for a Hosted Super Intelligence run. */
export function EvolveHostedProgressCard({ run }: { run: EvolveRunRecord }) {
  if (!run.cloudRunId && run.request.runsOn !== 'hosted') {
    return null
  }
  const progress = run.hostedProgress
  const active = run.state === 'running' || run.state === 'starting'
  const streaming = active && progress?.transport === 'stream'
  const evaluated = progress?.evaluated ?? 0
  const eliminated = progress?.eliminated ?? 0
  const remaining = Math.max(0, evaluated - eliminated)
  const knockedOutShare = evaluated > 0 ? Math.round((eliminated / evaluated) * 100) : 0
  const recent = (progress?.recent ?? []).toReversed()
  return (
    <section className="space-y-3" data-testid="evolve-hosted-progress">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {translate('evolveHosted.progress.title', 'Live tournament')}
        </h3>
        {active && (
          <span
            role="status"
            data-testid="evolve-hosted-transport"
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <span
              aria-hidden
              className={`size-1.5 rounded-full ${streaming ? 'animate-pulse bg-primary' : 'bg-muted-foreground'}`}
            />
            {streaming
              ? translate('evolveHosted.progress.live', 'Live')
              : translate('evolveHosted.progress.polling', 'Checking every 15 s')}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={translate('evolveHosted.progress.scored', 'Scored')} value={evaluated} />
        <Stat
          label={translate('evolveHosted.progress.knockedOut', 'Knocked out')}
          value={eliminated}
        />
        <Stat label={translate('evolveHosted.progress.stillIn', 'Still in')} value={remaining} />
        <Stat
          label={translate('evolveHosted.progress.leader', 'Leader')}
          value={progress?.best ? evolveScore(progress.best.score) : '—'}
        />
      </div>
      {evaluated > 0 && (
        <div className="space-y-1">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={knockedOutShare}
            aria-label={translate('evolveHosted.progress.knockedOutShare', 'Share knocked out')}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary" style={{ width: `${knockedOutShare}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'evolveHosted.progress.summary',
              '{{eliminated}} of {{evaluated}} knocked out{{generation}}',
              {
                eliminated,
                evaluated,
                generation:
                  progress?.generation !== undefined
                    ? translate('evolveHosted.progress.generationSuffix', ' · generation {{n}}', {
                        n: progress.generation
                      })
                    : ''
              }
            )}
          </p>
        </div>
      )}
      {recent.length > 0 ? (
        <ol className="space-y-1 text-xs" data-testid="evolve-hosted-progress-feed">
          {recent.map((entry) => (
            <li key={entry.id} className="flex gap-3">
              <time dateTime={entry.at} className="shrink-0 text-muted-foreground tabular-nums">
                {evolveTime(entry.at)}
              </time>
              <span
                className={`min-w-0 break-words ${entry.kind === 'eliminated' ? 'text-muted-foreground' : ''}`}
              >
                {entryText(entry)}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">
          {active
            ? translate('evolveHosted.progress.waiting', 'Waiting for the first candidate…')
            : translate('evolveHosted.progress.none', 'No candidate progress was recorded.')}
        </p>
      )}
    </section>
  )
}
