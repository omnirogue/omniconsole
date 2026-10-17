import { useState } from 'react'
import { Rocket, UserRound } from 'lucide-react'
import { UpNextSubject } from '@/components/next-action/UpNextSubject'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionBulkOutcome } from './session-bulk-outcome'
import { SessionBulkFleetDispatch } from './SessionBulkFleetDispatch'

export type SessionBulkItem = { key: string; label: string; session: SidebarSession }

type Run = { items: readonly SessionBulkItem[]; index: number; outcomes: SessionBulkOutcome[] }

/**
 * Dispatch shares one configuration across a fixed selection. Human handoff keeps the
 * per-conversation flow. Nothing is claimed unless its existing transport acknowledges it.
 */
export function SessionBulkNextStep({
  dispatch,
  items,
  label,
  disabled = false,
  onFinished
}: {
  dispatch: boolean
  items: readonly SessionBulkItem[]
  label: string
  disabled?: boolean
  onFinished: (outcomes: SessionBulkOutcome[]) => void
}): React.JSX.Element {
  const [run, setRun] = useState<Run | null>(null)
  const current = run ? (run.items[run.index] ?? null) : null
  const notSent = (item: SessionBulkItem): SessionBulkOutcome => ({
    key: item.key,
    label: item.label,
    ok: false,
    message: translate('conversations.bulkNotSent', 'not sent')
  })
  const finish = (outcomes: SessionBulkOutcome[]): void => {
    setRun(null)
    onFinished(outcomes)
  }
  const advance = (outcome: SessionBulkOutcome): void => {
    if (!run) {
      return
    }
    const outcomes = [...run.outcomes, outcome]
    if (run.index + 1 < run.items.length) {
      setRun({ ...run, index: run.index + 1, outcomes })
    } else {
      finish(outcomes)
    }
  }
  const stop = (): void => {
    if (run) {
      finish([...run.outcomes, ...run.items.slice(run.index).map(notSent)])
    }
  }
  return (
    <Popover
      open={run !== null}
      onOpenChange={(open) => {
        if (!open && !dispatch) {
          stop()
        }
      }}
    >
      <PopoverAnchor asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="gap-1"
          disabled={disabled || items.length === 0 || run !== null}
          data-session-bulk-action={dispatch ? 'dispatch' : 'send-to-human'}
          // Why: the run snapshots the selection so a prune mid-way cannot skip or repeat a row.
          onClick={() => setRun({ items: [...items], index: 0, outcomes: [] })}
        >
          {dispatch ? <Rocket className="size-3" /> : <UserRound className="size-3" />}
          {label}
        </Button>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={4}
        className="scrollbar-sleek max-h-[80vh] w-max max-w-[calc(100vw-1rem)] overflow-auto p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {run && dispatch ? (
          <SessionBulkFleetDispatch items={run.items} onFinished={finish} />
        ) : run && current ? (
          <div data-session-bulk-next-step={current.key}>
            <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium">
                {translate(
                  'conversations.bulkNextStepProgress',
                  '{{index}} of {{total}} · {{session}}',
                  { index: run.index + 1, total: run.items.length, session: current.label }
                )}
              </span>
              <Button variant="ghost" size="xs" onClick={() => advance(notSent(current))}>
                {translate('conversations.bulkNextStepSkip', 'Skip this one')}
              </Button>
              <Button variant="ghost" size="xs" onClick={stop}>
                {translate('conversations.bulkNextStepStop', 'Stop')}
              </Button>
            </div>
            {/* Why a definite width: the popover is `w-max`, under which every min-w-0/truncate
                inside the composer is inert and one long nowrap summary sets the popover's
                width. The fleet-dispatch branch above keeps w-max; the composer gets a box. */}
            <div className="w-[min(48rem,calc(100vw-1rem))]" data-session-bulk-next-step-composer>
              <UpNextSubject
                key={current.key}
                subject={{ kind: 'session', session: current.session }}
                onChanged={() => advance({ key: current.key, label: current.label, ok: true })}
              />
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
