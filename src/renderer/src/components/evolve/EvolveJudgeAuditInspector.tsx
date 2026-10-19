import { useId, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DEFAULT_MIN_INDEPENDENT_FAMILIES,
  familyList,
  flagKeys,
  formatShare,
  interpolate,
  isFlagged,
  resolveJudgeAuditLabels,
  summarizeJudgeAudit,
  swapState
} from './evolve-judge-audit-helpers'
import type {
  EvolveJudgeAuditLabelOverrides,
  EvolveJudgeAuditLabels,
  EvolveJudgeAuditStatus,
  EvolveJudgeAuditSummary,
  EvolveJudgment
} from './evolve-judge-audit-helpers'

type Filter = 'all' | 'flagged'
type Column = keyof EvolveJudgeAuditLabels['columns']

const FILTERS: readonly Filter[] = ['all', 'flagged']
const COLUMNS: readonly Column[] = [
  'judge',
  'candidateFamily',
  'order',
  'verdict',
  'swap',
  'confidence',
  'flags',
  'rationale'
]

const STATUS_VARIANT: Record<
  EvolveJudgeAuditStatus,
  'default' | 'destructive' | 'outline' | 'secondary'
> = {
  passed: 'default',
  failed: 'destructive',
  inconclusive: 'outline',
  not_run: 'secondary'
}
const SWAP_TONE: Record<ReturnType<typeof swapState>, string> = {
  consistent: 'text-emerald-700 dark:text-emerald-300',
  flipped: 'text-red-700 dark:text-red-300',
  notProbed: 'text-muted-foreground'
}
const cell = 'px-2 py-1.5 align-top'

type SummaryProps = {
  summary: EvolveJudgeAuditSummary
  text: EvolveJudgeAuditLabels
  minIndependentFamilies: number
}

function AuditSummary({ summary, text, minIndependentFamilies }: SummaryProps) {
  const items = [
    interpolate(text.tally, {
      candidate: summary.candidate,
      baseline: summary.baseline,
      tie: summary.tie,
      counted: summary.counted,
      total: summary.total
    }),
    interpolate(text.agreement, { share: formatShare(summary.agreement) }),
    interpolate(text.families, {
      families: familyList(summary.independentFamilies, text.family)
    }),
    interpolate(text.excluded, {
      selfPreference: summary.selfPreference,
      positionFlips: summary.positionFlips
    })
  ]
  return (
    <>
      <ul aria-label={text.summaryLabel} className="flex flex-wrap gap-2 text-xs">
        {items.map((item) => (
          <li key={item} className="rounded border bg-muted/30 px-1.5 py-0.5 tabular-nums">
            {item}
          </li>
        ))}
      </ul>
      {summary.status === 'inconclusive' && (
        <p role="note" className="text-xs text-muted-foreground">
          {interpolate(text.insufficientFamilies, { min: minIndependentFamilies })}
        </p>
      )}
    </>
  )
}

type RowProps = {
  judgment: EvolveJudgment
  text: EvolveJudgeAuditLabels
  open: boolean
  onToggle: (id: string) => void
  rationaleId: string
}

function JudgmentRows({ judgment, text, open, onToggle, rationaleId }: RowProps) {
  const flags = flagKeys(judgment)
  const swap = swapState(judgment)
  return (
    <>
      <tr
        data-testid={`evolve-judgment-${judgment.id}`}
        data-flagged={flags.length > 0}
        data-verdict={judgment.verdict}
        className={flags.length > 0 ? 'bg-amber-500/10' : undefined}
      >
        <th scope="row" className={`${cell} font-medium`}>
          <span className="block">{judgment.judgeLabel}</span>
          <span className="block text-[11px] font-normal text-muted-foreground">
            {text.family[judgment.judgeFamily]}
          </span>
        </th>
        <td className={cell}>{text.family[judgment.candidateFamily]}</td>
        <td className={`${cell} text-muted-foreground`}>{text.shownFirst[judgment.shownFirst]}</td>
        <td className={`${cell} font-semibold`}>{text.verdict[judgment.verdict]}</td>
        <td className={`${cell} ${SWAP_TONE[swap]}`} data-swap={swap}>
          {text.swap[swap]}
        </td>
        <td className={`${cell} tabular-nums`}>{formatShare(judgment.confidence)}</td>
        <td className={cell}>
          {flags.length === 0 ? (
            <span className="text-muted-foreground">{text.flags.none}</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {flags.map((flag) => (
                <Badge key={flag} variant="outline" data-flag={flag}>
                  {text.flags[flag]}
                </Badge>
              ))}
            </span>
          )}
        </td>
        <td className={cell}>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={open}
            aria-controls={rationaleId}
            onClick={() => onToggle(judgment.id)}
          >
            {open ? text.hideRationale : text.showRationale}
          </Button>
        </td>
      </tr>
      {open && (
        <tr id={rationaleId} data-testid={`evolve-judgment-rationale-${judgment.id}`}>
          <td colSpan={COLUMNS.length} className="bg-muted/20 px-3 py-2">
            <p className="text-[11px] font-semibold text-muted-foreground">
              {interpolate(text.rationaleFor, { judge: judgment.judgeLabel })}
            </p>
            <p className="mt-1 break-words whitespace-pre-wrap">
              {judgment.rationale?.trim() || text.noRationale}
            </p>
          </td>
        </tr>
      )}
    </>
  )
}

type InspectorProps = {
  judgments: readonly EvolveJudgment[]
  /** Distinct independent judge families required before the audit can pass. */
  minIndependentFamilies?: number
  /** Translated copy; anything left out falls back to the defaults in the helper. */
  labels?: EvolveJudgeAuditLabelOverrides
}

/** Every blind cross-family verdict behind an Evolve promotion, with the ones the audit set aside
 * (same-family judges, order-dependent verdicts) marked rather than hidden. */
export function EvolveJudgeAuditInspector({
  judgments,
  minIndependentFamilies = DEFAULT_MIN_INDEPENDENT_FAMILIES,
  labels
}: InspectorProps) {
  const baseId = useId()
  const [filter, setFilter] = useState<Filter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const text = useMemo(() => resolveJudgeAuditLabels(labels), [labels])
  const summary = useMemo(
    () => summarizeJudgeAudit(judgments, minIndependentFamilies),
    [judgments, minIndependentFamilies]
  )
  const visible = filter === 'flagged' ? judgments.filter(isFlagged) : judgments
  const toggle = (id: string) => setOpenId((current) => (current === id ? null : id))

  return (
    <section
      aria-labelledby={`${baseId}-title`}
      data-testid="evolve-judge-audit"
      data-status={summary.status}
      className="space-y-3"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 id={`${baseId}-title`} className="text-sm font-semibold">
            {text.title}
          </h3>
          <p className="text-xs text-muted-foreground">{text.description}</p>
        </div>
        <Badge variant={STATUS_VARIANT[summary.status]} data-testid="evolve-judge-audit-status">
          {text.status[summary.status]}
        </Badge>
      </header>
      {summary.total === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          {text.noJudgments}
        </p>
      ) : (
        <>
          <AuditSummary
            summary={summary}
            text={text}
            minIndependentFamilies={minIndependentFamilies}
          />
          <div role="group" aria-label={text.filter.label} className="flex gap-1">
            {FILTERS.map((value) => (
              <Button
                key={value}
                type="button"
                size="xs"
                variant={filter === value ? 'secondary' : 'ghost'}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {text.filter[value]}
              </Button>
            ))}
          </div>
          {visible.length === 0 ? (
            <p role="status" className="text-xs text-muted-foreground">
              {text.noFlagged}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border scrollbar-sleek">
              <table aria-label={text.tableLabel} className="w-full text-left text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    {COLUMNS.map((column) => (
                      <th
                        key={column}
                        scope="col"
                        className="px-2 py-1.5 font-medium whitespace-nowrap"
                      >
                        {text.columns[column]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {visible.map((judgment, index) => (
                    <JudgmentRows
                      key={judgment.id}
                      judgment={judgment}
                      text={text}
                      open={openId === judgment.id}
                      onToggle={toggle}
                      rationaleId={`${baseId}-rationale-${index}`}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
