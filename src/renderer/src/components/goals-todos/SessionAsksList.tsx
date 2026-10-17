import { useState } from 'react'
import { CircleCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { SessionAskOutputs } from '@/lib/session-ask-outputs'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { SessionAsk } from '../../../../shared/session-asks'
import { MilestoneMark } from './SessionProgress'

/** Asks shown before "N earlier": the current one and the two before it. */
export const SESSION_ASKS_SHOWN = 3

type AskState = 'now' | 'you' | 'answered' | 'todo'

function askState(
  ask: SessionAsk,
  isLatest: boolean,
  paneState: AgentStatusState | null | undefined
): AskState {
  if (isLatest && paneState === 'working') {
    return 'now'
  }
  if (isLatest && (paneState === 'waiting' || paneState === 'blocked') && ask.answered) {
    return 'you'
  }
  return ask.answered ? 'answered' : 'todo'
}

/** An outline check: the AI finished its turn on the ask, which is not proof the work is done. */
function AskMark({ state }: { state: AskState }): React.JSX.Element {
  if (state === 'answered') {
    return (
      <span
        role="img"
        aria-label={translate('sessionAsks.answered', 'Answered')}
        data-session-ask-mark="answered"
        className="inline-flex shrink-0"
      >
        <CircleCheck className="size-4 text-status-success" aria-hidden />
      </span>
    )
  }
  return <MilestoneMark status={state} />
}

function count(value: number, one: string, other: string): string | null {
  if (value === 0) {
    return null
  }
  return value === 1 ? one : other
}

/** "PR #1002, #1003 · 3 images · 1 video": what an ask produced, in a few words. */
export function askOutputsLabel(outputs: SessionAskOutputs): string {
  return [
    outputs.pullRequests.length > 0
      ? translate('sessionAsks.pullRequests', 'PR {{list}}', {
          list: outputs.pullRequests.map((number) => `#${number}`).join(', ')
        })
      : null,
    count(
      outputs.images,
      translate('sessionAsks.images_one', '{{count}} image', { count: 1 }),
      translate('sessionAsks.images_other', '{{count}} images', { count: outputs.images })
    ),
    count(
      outputs.videos,
      translate('sessionAsks.videos_one', '{{count}} video', { count: 1 }),
      translate('sessionAsks.videos_other', '{{count}} videos', { count: outputs.videos })
    ),
    count(
      outputs.audio,
      translate('sessionAsks.audio_one', '{{count}} audio file', { count: 1 }),
      translate('sessionAsks.audio_other', '{{count}} audio files', { count: outputs.audio })
    ),
    count(
      outputs.documents,
      translate('sessionAsks.files_one', '{{count}} file', { count: 1 }),
      translate('sessionAsks.files_other', '{{count}} files', { count: outputs.documents })
    ),
    count(
      outputs.links,
      translate('sessionAsks.links_one', '{{count}} link', { count: 1 }),
      translate('sessionAsks.links_other', '{{count}} links', { count: outputs.links })
    )
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

function AskRow({
  ask,
  outputs,
  state
}: {
  ask: SessionAsk
  outputs: SessionAskOutputs | undefined
  state: AskState
}): React.JSX.Element {
  const produced = outputs ? askOutputsLabel(outputs) : ''
  return (
    <li className="flex min-w-0 items-start gap-2" data-session-ask={state}>
      <span className="mt-px">
        <AskMark state={state} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={state === 'now' ? 'block truncate font-medium' : 'block truncate'}
          title={ask.full}
        >
          {ask.title}
        </span>
        {produced ? (
          <span className="block truncate text-muted-foreground" title={produced}>
            {produced}
          </span>
        ) : null}
      </span>
    </li>
  )
}

/**
 * The to-do list for any kind of session: the person's asks, oldest first, the latest three
 * shown. The latest is ● while the AI works and ! when it waits on the person; an answered ask
 * gets an outline ✓ (the AI's turn ended — solid green stays for proven milestones).
 */
export function SessionAsksList({
  asks,
  outputs,
  paneState
}: {
  asks: readonly SessionAsk[]
  outputs: readonly SessionAskOutputs[]
  paneState: AgentStatusState | null | undefined
}): React.JSX.Element {
  const [showEarlier, setShowEarlier] = useState(false)
  const hidden = showEarlier ? 0 : Math.max(0, asks.length - SESSION_ASKS_SHOWN)
  return (
    <div className="space-y-1" data-session-asks={asks.length}>
      {hidden > 0 ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto px-0 text-xs text-muted-foreground"
          onClick={() => setShowEarlier(true)}
        >
          {hidden === 1
            ? translate('sessionAsks.earlier_one', '{{count}} earlier ask', { count: 1 })
            : translate('sessionAsks.earlier_other', '{{count}} earlier asks', { count: hidden })}
        </Button>
      ) : null}
      <ol className="space-y-1">
        {asks.map((ask, position) =>
          position < hidden ? null : (
            <AskRow
              key={ask.index}
              ask={ask}
              outputs={outputs[position]}
              state={askState(ask, position === asks.length - 1, paneState)}
            />
          )
        )}
      </ol>
    </div>
  )
}
