import { useMemo } from 'react'
import { Check, Crown, Trophy } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import {
  behavioralDeltas,
  buildKnockoutBracket,
  buildSemanticDiff,
  familyEloStandings,
  formatSignedDelta
} from './evolve-leaderboard-helpers'
import type {
  EvolveBehaviorDelta,
  EvolveBehaviorMetric,
  EvolveBracket,
  EvolveBracketEntrant,
  EvolveBracketMatch,
  EvolveBracketRound,
  EvolveDiffKind,
  EvolveDiffRow,
  EvolveEloStanding,
  EvolveFamilyRecord
} from './evolve-leaderboard-helpers'
import { evolveScore } from './evolve-run-text'

/** Everything the drawer shows for one hosted challenge, finished or still being judged. */
export type EvolveLeaderboard = {
  runId: string
  entrants: EvolveBracketEntrant[]
  incumbent: EvolveBracketEntrant
  familyRecords: EvolveFamilyRecord[]
  baseline: { label: string; text: string }
  winner: { label: string; text: string }
  behaviors: EvolveBehaviorMetric[]
}

const roundLabel = (round: EvolveBracketRound) =>
  ({
    round_of_4: translate('evolveLeaderboard.round.roundOf4', 'Round of 4'),
    final: translate('evolveLeaderboard.round.final', 'Final'),
    incumbent_challenge: translate('evolveLeaderboard.round.challenge', 'Incumbent challenge')
  })[round]

const diffKindLabel = (kind: EvolveDiffKind) =>
  ({
    same: translate('evolveLeaderboard.diff.same', 'Unchanged'),
    added: translate('evolveLeaderboard.diff.added', 'Added'),
    removed: translate('evolveLeaderboard.diff.removed', 'Removed'),
    modified: translate('evolveLeaderboard.diff.modified', 'Modified')
  })[kind]

const directionLabel = (direction: EvolveBehaviorDelta['direction']) =>
  ({
    improved: translate('evolveLeaderboard.delta.improved', 'Improved'),
    regressed: translate('evolveLeaderboard.delta.regressed', 'Regressed'),
    unchanged: translate('evolveLeaderboard.delta.unchanged', 'Unchanged')
  })[direction]

// [baseline side, winner side] backgrounds, and the summary chip for each kind.
const DIFF_TONE: Record<EvolveDiffKind, [string, string]> = {
  same: ['', ''],
  added: ['bg-muted/30', 'bg-emerald-500/15'],
  removed: ['bg-red-500/15', 'bg-muted/30'],
  modified: ['bg-amber-500/15', 'bg-amber-500/15']
}
const DIRECTION_TONE: Record<EvolveBehaviorDelta['direction'], string> = {
  improved: 'text-emerald-700 dark:text-emerald-300',
  regressed: 'text-red-700 dark:text-red-300',
  unchanged: 'text-muted-foreground'
}
const cell = 'px-2 py-1.5 align-top tabular-nums'
const gutter = 'border-r px-1.5 text-right text-muted-foreground tabular-nums select-none'
const text = 'px-2 break-words whitespace-pre-wrap'

type MatchProps = { match: EvolveBracketMatch; incumbentId: string }

function BracketMatchCard({ match, incumbentId }: MatchProps) {
  const won = translate('evolveLeaderboard.advances', 'Advances')
  return (
    <li
      data-testid={`evolve-bracket-match-${match.id}`}
      className="rounded-md border bg-background p-1.5 text-xs"
    >
      {([
        { slot: match.top, slotKey: `${match.id}-top` },
        { slot: match.bottom, slotKey: `${match.id}-bottom` }
      ] as const).map(({ slot, slotKey }) => {
        if (!slot) {
          return (
            <div key={slotKey} className="rounded px-1.5 py-1 text-muted-foreground italic">
              {translate('evolveLeaderboard.toBeDecided', 'To be decided')}
            </div>
          )
        }
        const { entrant } = slot
        const advances = entrant.id === match.winnerId
        return (
          <div
            key={entrant.id}
            data-advances={advances}
            className={`flex items-center justify-between gap-2 rounded px-1.5 py-1 ${
              advances ? 'bg-primary/10 font-semibold text-foreground' : 'text-muted-foreground'
            }`}
          >
            <span className="min-w-0 truncate">
              <span className="mr-1 text-[11px] font-normal tabular-nums">
                {entrant.id === incumbentId
                  ? translate('evolveLeaderboard.incumbentTag', 'Incumbent')
                  : `#${entrant.seed}`}
              </span>
              {entrant.label}
              <span className="ml-1 text-[11px] font-normal">{entrant.family}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1 tabular-nums">
              {advances && <Check role="img" aria-label={won} className="size-3 text-primary" />}
              {evolveScore(slot.score)}
            </span>
          </div>
        )
      })}
      {match.winnerId === null && (
        <p className="px-1.5 pt-1 text-[11px] text-muted-foreground">
          {translate('evolveLeaderboard.awaitingResult', 'Awaiting result')}
        </p>
      )}
    </li>
  )
}

function championLine({ champion, incumbentRetained }: EvolveBracket): string {
  if (!champion) {
    return translate('evolveLeaderboard.pending', 'The bracket is still being judged.')
  }
  const values = { label: champion.label, family: champion.family }
  return incumbentRetained
    ? translate('evolveLeaderboard.retained', '{{label}} keeps the title.', values)
    : translate('evolveLeaderboard.won', '{{label}} ({{family}}) beat the local baseline.', values)
}

function BracketSection({ leaderboard }: { leaderboard: EvolveLeaderboard }) {
  const incumbentId = leaderboard.incumbent.id
  let bracket: EvolveBracket
  try {
    bracket = buildKnockoutBracket(leaderboard.entrants, leaderboard.incumbent)
  } catch (error) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {translate('evolveLeaderboard.bracketError', 'This bracket cannot be drawn: {{reason}}', {
          reason: error instanceof Error ? error.message : String(error)
        })}
      </p>
    )
  }
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">
        {translate('evolveLeaderboard.bracketTitle', 'Knockout tournament')}
      </h3>
      <div className="grid gap-3 sm:grid-cols-3">
        {bracket.rounds.map(({ round, matches }) => (
          <div key={round} data-testid={`evolve-bracket-round-${round}`} className="space-y-2">
            <h4 className="text-xs font-semibold text-muted-foreground">{roundLabel(round)}</h4>
            <ol className="space-y-2">
              {matches.map((match) => (
                <BracketMatchCard key={match.id} match={match} incumbentId={incumbentId} />
              ))}
            </ol>
          </div>
        ))}
      </div>
      <p role="status" className="flex items-center gap-1.5 text-xs font-medium">
        {bracket.champion && (
          <Trophy aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
        )}
        {championLine(bracket)}
      </p>
    </section>
  )
}

function EloRow({ standing }: { standing: EvolveEloStanding }) {
  const { family, rating, lower, upper } = standing
  return (
    <tr data-family={family}>
      <th scope="row" className="px-2 py-1.5 align-top font-medium">
        <span className="flex flex-wrap items-center gap-1.5">
          {family}
          {standing.warmStartChampion && (
            <Badge variant="outline" className="gap-1">
              <Crown aria-hidden="true" className="size-3 text-primary" />
              {translate('evolveLeaderboard.warmStart', 'Warm-start champion')}
            </Badge>
          )}
        </span>
      </th>
      <td className={`${cell} font-semibold`}>{rating ?? '—'}</td>
      <td className={cell}>{lower === null || upper === null ? '—' : `${lower}–${upper}`}</td>
      <td className={cell}>{`${standing.wins}–${standing.losses}–${standing.draws}`}</td>
      <td className={cell}>{standing.games}</td>
    </tr>
  )
}

function EloSection({ records }: { records: readonly EvolveFamilyRecord[] }) {
  const head = [
    translate('evolveLeaderboard.elo.family', 'Model family'),
    translate('evolveLeaderboard.elo.rating', 'Elo'),
    translate('evolveLeaderboard.elo.interval', '95% CI'),
    translate('evolveLeaderboard.elo.record', 'W–L–D'),
    translate('evolveLeaderboard.elo.games', 'Games')
  ]
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">
        {translate('evolveLeaderboard.eloTitle', 'Elo by model family')}
      </h3>
      <div className="overflow-x-auto rounded-md border scrollbar-sleek">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              {head.map((label) => (
                <th key={label} scope="col" className="px-2 py-1.5 font-medium whitespace-nowrap">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {familyEloStandings(records).map((standing) => (
              <EloRow key={standing.family} standing={standing} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'evolveLeaderboard.eloNote',
          'Performance Elo from pairwise blind-audit results against the field (base 1500); the bounds are a 95% Wilson interval.'
        )}
      </p>
    </section>
  )
}

function DiffTable({ rows, sides }: { rows: EvolveDiffRow[]; sides: [string, string] }) {
  return (
    <div className="max-h-[28rem] overflow-auto rounded-md border scrollbar-sleek">
      <table
        aria-label={translate('evolveLeaderboard.diffTable', 'Side-by-side semantic diff')}
        className="w-full table-fixed border-collapse font-mono text-[11px]"
      >
        <colgroup>
          <col className="w-10" />
          <col />
          <col className="w-10" />
          <col />
        </colgroup>
        <thead className="sticky top-0 bg-muted font-sans text-muted-foreground">
          <tr>
            {sides.map((label, side) => (
              <th key={side} scope="col" colSpan={2} className="px-2 py-1.5 text-left font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ kind, left, right }) => (
            <tr key={`${left?.number ?? '-'}:${right?.number ?? '-'}`} data-kind={kind}>
              <td className={`${gutter} ${DIFF_TONE[kind][0]}`}>
                {kind !== 'same' && <span className="sr-only">{diffKindLabel(kind)}</span>}
                {left?.number}
              </td>
              <td className={`${text} ${DIFF_TONE[kind][0]}`}>{left?.text}</td>
              <td className={`${gutter} ${DIFF_TONE[kind][1]}`}>{right?.number}</td>
              <td className={`${text} ${DIFF_TONE[kind][1]}`}>{right?.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const metricValue = (value: number, unit = '') => `${Number(value.toFixed(2))}${unit}`

function DiffSection({ leaderboard }: { leaderboard: EvolveLeaderboard }) {
  const { baseline, winner } = leaderboard
  const diff = useMemo(
    () => buildSemanticDiff(baseline.text, winner.text),
    [baseline.text, winner.text]
  )
  const counts: [EvolveDiffKind, number][] = [
    ['added', diff.added],
    ['removed', diff.removed],
    ['modified', diff.modified],
    ['same', diff.unchanged]
  ]
  const deltas = behavioralDeltas(leaderboard.behaviors)
  // The interpolation reads each side's label.
  const sides: [string, string] = [
    translate('evolveLeaderboard.left', 'Local baseline (incumbent): {{label}}', baseline),
    translate('evolveLeaderboard.right', 'Hosted Super Intelligence winner: {{label}}', winner)
  ]
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">
        {translate('evolveLeaderboard.diffTitle', 'Local baseline vs hosted winner')}
      </h3>
      <ul
        aria-label={translate('evolveLeaderboard.diffSummary', 'Diff summary')}
        className="flex flex-wrap gap-2 text-xs"
      >
        {counts.map(([kind, total]) => (
          <li
            key={kind}
            className={`rounded border px-1.5 py-0.5 tabular-nums ${DIFF_TONE[kind][1]}`}
          >
            {`${diffKindLabel(kind)}: ${total}`}
          </li>
        ))}
      </ul>
      {deltas.length > 0 && (
        <ul
          aria-label={translate('evolveLeaderboard.behaviorTitle', 'Key behavioral deltas')}
          className="grid gap-1.5 sm:grid-cols-2"
        >
          {deltas.map((delta) => (
            <li
              key={delta.id}
              data-direction={delta.direction}
              className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"
            >
              <span className="min-w-0 truncate">{delta.label}</span>
              <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
                <span className="text-muted-foreground">
                  {`${metricValue(delta.baseline, delta.unit)} → ${metricValue(delta.winner, delta.unit)}`}
                </span>
                <span className={`font-semibold ${DIRECTION_TONE[delta.direction]}`}>
                  {formatSignedDelta(delta.delta, delta.unit)}
                </span>
                <Badge variant="outline">{directionLabel(delta.direction)}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
      {diff.unchanged === diff.rows.length ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate(
            'evolveLeaderboard.noDifferences',
            'No semantic differences: the winner matches the baseline line for line.'
          )}
        </p>
      ) : (
        <DiffTable rows={diff.rows} sides={sides} />
      )}
    </section>
  )
}

type DrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  leaderboard: EvolveLeaderboard
}

/** The hosted champion's bracket, family Elo and what it changed against the local baseline. */
export function EvolveLeaderboardDrawer({ open, onOpenChange, leaderboard }: DrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-4xl" data-testid="evolve-leaderboard-drawer">
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle>{translate('evolveLeaderboard.title', 'Champion leaderboard')}</SheetTitle>
          <SheetDescription>
            {translate(
              'evolveLeaderboard.description',
              'Run {{runId}}: knockout bracket, Elo by model family and what the hosted winner changed.',
              { runId: leaderboard.runId }
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 scrollbar-sleek">
          <BracketSection leaderboard={leaderboard} />
          <EloSection records={leaderboard.familyRecords} />
          <DiffSection leaderboard={leaderboard} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
