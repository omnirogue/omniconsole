import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import type { SessionDetailsFacts } from './session-details-facts'

/** Characters a path-like fact keeps on the line before its head is folded into "…". */
export const FACT_PATH_MAX = 40

/**
 * Keep the tail: "…/omni-brand · refs/heads/main-next", never "/Users/maintainer/Work/…". The
 * cut lands on the next "/" when one is near, so a folded path still starts at a segment; the
 * full value travels in `title` beside it.
 */
export function frontTruncate(value: string, max = FACT_PATH_MAX): string {
  if (value.length <= max) {
    return value
  }
  const tail = value.slice(-(max - 1))
  const slash = tail.indexOf('/')
  return `…${slash > 0 && slash < Math.floor(tail.length / 2) ? tail.slice(slash) : tail}`
}

/** The parts of the one-line summary, in reading order; the line joins them with " · ". */
export function sessionFactParts(facts: SessionDetailsFacts): { text: string; full: string }[] {
  const task = facts.task?.title ?? translate('nextAction.none', 'none')
  return [
    { text: facts.agent.name, full: facts.agent.name },
    { text: facts.runsOn, full: facts.runsOn },
    { text: frontTruncate(facts.workspace), full: facts.workspace },
    {
      text: translate('nextAction.factsTask', 'Task: {{task}}', { task }),
      full: translate('nextAction.factsTask', 'Task: {{task}}', { task })
    }
  ].filter((part) => part.text)
}

/**
 * Session details folded to one muted line — "Codex · This device · …/omni-brand · main-next ·
 * Task: none" — with the "Details" disclosure that opens today's full card (brief 78 #3). The
 * line owns the composer's whole width, so the chain beside nothing gets all of it.
 */
export function SessionFactsLine({
  facts,
  open,
  controls,
  onToggle
}: {
  facts: SessionDetailsFacts
  open: boolean
  /** The id of the card the disclosure opens, for `aria-controls`. */
  controls: string
  onToggle: () => void
}): React.JSX.Element {
  const parts = sessionFactParts(facts)
  const full = parts.map((part) => part.full).join(' · ')
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-1 text-xs text-muted-foreground"
      data-next-action-facts-line
    >
      <span className="min-w-0 flex-1 truncate" title={full}>
        {parts.map((part, index) => (
          <span key={index} title={part.full === part.text ? undefined : part.full}>
            {index > 0 ? ' · ' : ''}
            {part.text}
          </span>
        ))}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-5 shrink-0 gap-0.5 px-1 text-xs text-muted-foreground"
        aria-expanded={open}
        aria-controls={controls}
        aria-label={`${translate('nextAction.detailsToggle', 'Details')} — ${translate(
          'nextAction.sessionDetails',
          'Session details'
        )}`}
        data-next-action-details-toggle
        onClick={onToggle}
      >
        {translate('nextAction.detailsToggle', 'Details')}
        <span aria-hidden>{open ? '▾' : '▸'}</span>
      </Button>
    </div>
  )
}
