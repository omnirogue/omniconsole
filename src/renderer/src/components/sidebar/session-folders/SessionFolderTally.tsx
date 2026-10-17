import { translate } from '@/i18n/i18n'
import type {
  SessionFolderTally as Tally,
  SessionFolderTallyState
} from '@/lib/session-folder-rollup'
import { cn } from '@/lib/utils'

type TallyPart = { state: SessionFolderTallyState; count: number; label: string }

/** The non-zero states of a folder, in the order a person scans them. */
export function sessionFolderTallyParts(tally: Tally): TallyPart[] {
  return [
    {
      state: 'working' as const,
      count: tally.working,
      label: translate('conversations.folderTally.working', '{{count}} working', {
        count: tally.working
      })
    },
    {
      state: 'needsYou' as const,
      count: tally.needsYou,
      label: translate('conversations.folderTally.needsYou', '{{count}} needs you', {
        count: tally.needsYou
      })
    },
    {
      state: 'waiting' as const,
      count: tally.waiting,
      label: translate('conversations.folderTally.waiting', '{{count}} waiting', {
        count: tally.waiting
      })
    },
    {
      state: 'stopped' as const,
      count: tally.stopped,
      label: translate('conversations.folderTally.stopped', '{{count}} stopped', {
        count: tally.stopped
      })
    },
    {
      state: 'cantSee' as const,
      count: tally.cantSee,
      label: translate('conversations.folderTally.cantSee', "{{count}} can't see", {
        count: tally.cantSee
      })
    }
  ].filter((part) => part.count > 0)
}

export function sessionFolderDoneLabel(tally: Tally): string {
  return translate('conversations.folderTally.done', '{{done}}/{{total}} done', {
    done: tally.done,
    total: tally.total
  })
}

/** "3 working · 1 needs you · 2/6 done": the heading's counts, muted except for a question. */
export function SessionFolderTally({ tally }: { tally: Tally }): React.JSX.Element {
  const parts = sessionFolderTallyParts(tally)
  const done = sessionFolderDoneLabel(tally)
  const summary = [...parts.map((part) => part.label), done].join(' · ')
  return (
    <span
      data-session-folder-tally=""
      title={summary}
      aria-label={summary}
      className="min-w-0 shrink truncate text-[10px] tabular-nums text-muted-foreground"
    >
      {parts.map((part) => (
        <span
          key={part.state}
          data-session-folder-tally-state={part.state}
          className={cn(part.state === 'needsYou' && 'font-semibold text-agent-question-text')}
        >
          {part.label}
          {' · '}
        </span>
      ))}
      <span data-session-folder-tally-state="done">{done}</span>
    </span>
  )
}

// Why these tones: the strip repeats the rows' own resting tints (session-row-tone), no new colors.
const STRIP_TONE: Record<SessionFolderTallyState, string> = {
  needsYou: 'bg-session-tone-needs-you',
  working: 'bg-session-tone-active',
  waiting: 'bg-session-tone-waiting',
  stopped: 'bg-session-tone-stopped',
  cantSee: 'bg-muted-foreground/40',
  done: 'bg-muted-foreground/20'
}

const STRIP_ORDER: SessionFolderTallyState[] = [
  'needsYou',
  'working',
  'waiting',
  'stopped',
  'cantSee',
  'done'
]

/** A thin proportional bar along the heading's foot; absolutely placed, so it shifts no layout. */
export function SessionFolderStatusStrip({ tally }: { tally: Tally }): React.JSX.Element | null {
  if (tally.total === 0) {
    return null
  }
  return (
    <span
      aria-hidden
      data-session-folder-strip=""
      className="pointer-events-none absolute inset-x-1 bottom-0 flex h-0.5 overflow-hidden rounded-full"
    >
      {STRIP_ORDER.filter((state) => tally[state] > 0).map((state) => (
        <span
          key={state}
          data-session-folder-strip-state={state}
          className={STRIP_TONE[state]}
          style={{ width: `${(tally[state] / tally.total) * 100}%` }}
        />
      ))}
    </span>
  )
}
