import React from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  useActivityTerminalLoadingLabel,
  useActivityTerminalPortalStatus
} from '../activity/activity-terminal-portal-status'

type AttentionTerminalSlotProps = {
  /** An Attention slot, or another page's single slot (a project's chat). */
  slotId: string
  label: string
  focused: boolean
  onFocusSlot: () => void
  header: React.ReactNode
  /** The pane portaled into this slot; `paneKey` null shows a whole tab and skips readiness gating. */
  pane: { paneKey: string | null } | null
  target: HTMLElement | null
  setTarget: (target: HTMLElement | null) => void
  empty: React.ReactNode
  tone?: 'default' | 'attention'
  style?: React.CSSProperties
  /** Controls at the end of the header strip (the Chat / Terminal switch). */
  trailing?: React.ReactNode
}

/** One half of the attention view: a header strip above a terminal portal target. */
export function AttentionTerminalSlot({
  slotId,
  label,
  focused,
  onFocusSlot,
  header,
  pane,
  target,
  setTarget,
  empty,
  tone = 'default',
  style,
  trailing
}: AttentionTerminalSlotProps): React.JSX.Element {
  const status = useActivityTerminalPortalStatus(target, pane?.paneKey ?? null)
  const gated = Boolean(pane?.paneKey)
  const loading = gated && status !== 'ready'
  const unavailable = gated && status === 'unavailable'
  const showLoadingLabel = useActivityTerminalLoadingLabel(loading && !unavailable)

  return (
    <section
      aria-label={label}
      data-attention-slot={slotId}
      data-attention-slot-focused={focused ? '' : undefined}
      data-attention-slot-empty={pane ? undefined : ''}
      className="flex min-h-0 min-w-0 flex-col"
      style={style}
      onPointerDownCapture={onFocusSlot}
      onFocusCapture={onFocusSlot}
    >
      <div
        className={cn(
          'flex min-h-11 shrink-0 items-start gap-2 border-b border-border px-3 py-2 transition-colors',
          tone === 'attention' && pane && 'bg-agent-question/8',
          focused && 'bg-accent/50'
        )}
      >
        {header}
        {trailing ? <div className="shrink-0 pt-px">{trailing}</div> : null}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-editor-surface">
        {/* Why: Terminal stays mounted in the hidden workspace tree; this target moves that existing TerminalPane here instead of spawning a second PTY/xterm owner. */}
        <div
          ref={setTarget}
          data-attention-terminal-target={slotId}
          className="absolute inset-0 min-h-0 min-w-0"
        />
        {!pane ? (
          <div
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-editor-surface p-6 text-center text-sm text-muted-foreground"
            data-attention-slot-placeholder=""
          >
            {empty}
          </div>
        ) : loading ? (
          <div
            className="pointer-events-none absolute inset-0 z-20 bg-editor-surface"
            aria-hidden="true"
          >
            {unavailable ? (
              <div className="ml-3 mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-background/85 px-2 py-1 text-xs text-muted-foreground shadow-xs">
                <span className="h-3 w-1.5 rounded-sm bg-muted-foreground/70" />
                <span>
                  {translate(
                    'auto.components.attention.AttentionPage.terminalUnavailable',
                    'Terminal unavailable'
                  )}
                </span>
              </div>
            ) : showLoadingLabel ? (
              <div className="ml-3 mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-background/85 px-2 py-1 text-xs text-muted-foreground shadow-xs">
                <span className="h-3 w-1.5 animate-pulse rounded-sm bg-muted-foreground/70" />
                <span>
                  {translate(
                    'auto.components.attention.AttentionPage.connectingTerminal',
                    'Connecting terminal…'
                  )}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
