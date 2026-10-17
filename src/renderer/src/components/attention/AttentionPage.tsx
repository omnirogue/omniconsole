import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Focus, LayoutTemplate } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { setActivityTerminalPortals } from '../activity/activity-terminal-portal'
import { requestBackgroundTerminalWorktreeMount } from '../terminal/background-terminal-worktree-mount'
import { UpNextControls } from '../next-action/UpNextControls'
import { SessionChainStatus } from '../next-step/SessionChainStatus'
import { useSessionChainForRow } from '@/lib/session-chain-registry'
import { useSidebarSessions } from '../sidebar/session-folders/use-sidebar-sessions'
import type { AttentionPane } from './agent-pane-snapshot'
import { openAttentionPaneInWorkspace } from './attention-actions'
import {
  resolveAttentionCurrentSurface,
  selectAttentionCurrentSurfaceInputs
} from './attention-current-surface'
import { stepAttentionPane as stepPane } from './attention-pane-stepping'
import {
  buildAttentionPortalDescriptors,
  resolveAttentionSlots,
  type AttentionSlotId
} from './attention-slot'
import { useAttentionSplitRatio } from './attention-split-ratio'
import { AttentionLaunchBar } from './AttentionLaunchBar'
import { NextStepsInbox } from '../next-steps/NextStepsInbox'
import { AttentionCurrentHeader, AttentionNeedsYouHeader } from './AttentionSlotHeaders'
import { AttentionTerminalSlot } from './AttentionTerminalSlot'
import { RunAttentionAction } from './RunAttentionAction'
import { useAgentPaneSnapshot } from './use-agent-pane-snapshot'
import { useAttentionWorkspaceLabel as useWorkspaceLabel } from './use-attention-workspace-label'

/**
 * Two screens and nothing else: the terminal being worked in, and whichever
 * terminal is waiting on the user. Both are the live TerminalPanes portaled out
 * of the hidden workbench, so no second PTY or xterm is ever created.
 */
export default function AttentionPage(): React.JSX.Element {
  const snapshot = useAgentPaneSnapshot()
  const currentInputs = useAppStore(useShallow(selectAttentionCurrentSurfaceInputs))
  const current = useMemo(() => resolveAttentionCurrentSurface(currentInputs), [currentInputs])
  const currentPane = current.kind === 'terminal' ? current.pane : null
  const currentWorkspaceLabel = useWorkspaceLabel(currentPane?.worktreeId ?? null)
  // Why: the model the session itself reports, not the one a launch requested.
  const currentSessionModel = useAppStore((state) =>
    currentPane ? (state.agentStatusByPaneKey[currentPane.paneKey]?.model ?? null) : null
  )
  const launchWorktreeId = currentPane?.worktreeId ?? currentInputs.activeWorktreeId ?? null
  const setActiveView = useAppStore((state) => state.setActiveView)
  const [focusedSlot, setFocusedSlot] = useState<AttentionSlotId>('current')
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null)
  const [currentTarget, setCurrentTarget] = useState<HTMLElement | null>(null)
  const [needsYouTarget, setNeedsYouTarget] = useState<HTMLElement | null>(null)
  // Why a ref: the pane the user is still typing in must survive the store dropping it from "needs you".
  const lastNeedsYouRef = useRef<AttentionPane | null>(null)
  const { ratio, isResizing, onResizeStart } = useAttentionSplitRatio()

  const slots = resolveAttentionSlots({
    current: currentPane,
    attention: snapshot.attention,
    heldPane: lastNeedsYouRef.current,
    holdActive: focusedSlot === 'needs-you',
    selectedPaneKey
  })
  const needsYou = slots.needsYou

  useLayoutEffect(() => {
    lastNeedsYouRef.current = needsYou
  }, [needsYou])

  const descriptors = useMemo(
    () =>
      buildAttentionPortalDescriptors({
        current: currentPane,
        currentTarget,
        needsYou,
        needsYouTarget,
        sharesCurrentTab: slots.sharesCurrentTab,
        focusedSlot
      }),
    [currentPane, currentTarget, needsYou, needsYouTarget, slots.sharesCurrentTab, focusedSlot]
  )

  // Why useLayoutEffect: publish before paint so Terminal's portal subscriber rerenders in the same commit.
  useLayoutEffect(() => {
    setActivityTerminalPortals(descriptors, 'attention')
  }, [descriptors])

  const setPageRef = useCallback((node: HTMLDivElement | null): void => {
    if (!node) {
      // Why: portal cleanup only on page unmount; clearing per change would flash the workspace pane behind a slot.
      setActivityTerminalPortals([], 'attention')
    }
  }, [])

  const needsYouWorktreeId = needsYou?.worktreeId ?? null
  const needsYouTabId = needsYou?.tabId ?? null
  const needsYouRoutable = Boolean(needsYou?.portalPaneKey)
  useEffect(() => {
    // Why: a worktree the user never opened this session has no mounted panes; a targeted background mount lets its pane render here.
    if (
      needsYouWorktreeId &&
      needsYouTabId &&
      needsYouRoutable &&
      needsYouWorktreeId !== currentInputs.activeWorktreeId
    ) {
      requestBackgroundTerminalWorktreeMount({
        worktreeId: needsYouWorktreeId,
        tabIds: [needsYouTabId]
      })
    }
  }, [currentInputs.activeWorktreeId, needsYouRoutable, needsYouTabId, needsYouWorktreeId])

  const focusCurrent = useCallback(() => setFocusedSlot('current'), [])
  const focusNeedsYou = useCallback(() => setFocusedSlot('needs-you'), [])
  const showWorkspace = useCallback(() => setActiveView('terminal'), [setActiveView])
  const total = snapshot.attention.length

  return (
    <div
      ref={setPageRef}
      data-attention-page=""
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <Focus className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <h1 className="text-sm font-semibold">
          {translate('auto.components.attention.AttentionPage.title', 'Attention')}
        </h1>
        <span className="text-xs text-muted-foreground" data-attention-total={total}>
          {total === 0
            ? translate(
                'auto.components.attention.AttentionPage.nothingNeedsYou',
                'Nothing needs you'
              )
            : translate(
                'auto.components.attention.AttentionPage.needYouCount',
                '{{count}} need you',
                {
                  count: total
                }
              )}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto gap-1.5" onClick={showWorkspace}>
          <LayoutTemplate className="size-3.5" />
          {translate('auto.components.attention.AttentionPage.workspaceView', 'Workspace view')}
        </Button>
      </header>
      <AttentionLaunchBar worktreeId={launchWorktreeId} />
      <NextStepsInbox />
      <main className="flex min-h-0 flex-1">
        <AttentionTerminalSlot
          slotId="current"
          label={translate('auto.components.attention.AttentionPage.workingOn', 'Working on')}
          focused={focusedSlot === 'current'}
          onFocusSlot={focusCurrent}
          style={{ flex: `${ratio} 1 0%` }}
          pane={
            currentPane
              ? { paneKey: slots.sharesCurrentTab ? null : currentPane.paneKey || null }
              : null
          }
          target={currentTarget}
          setTarget={setCurrentTarget}
          header={
            currentPane ? (
              <AttentionCurrentHeader
                label={currentPane.label}
                workspaceLabel={currentWorkspaceLabel}
                worktreeId={currentPane.worktreeId}
                agent={currentPane.agent}
                sessionModel={currentSessionModel}
                trailing={
                  currentPane.paneKey ? (
                    <CurrentSessionControls paneKey={currentPane.paneKey} />
                  ) : null
                }
              />
            ) : (
              <div className="min-w-0 flex-1 text-sm font-semibold leading-snug">
                {translate('auto.components.attention.AttentionPage.workingOn', 'Working on')}
              </div>
            )
          }
          empty={
            current.kind === 'other' ? (
              <div className="flex flex-col items-center gap-2">
                <span>
                  {translate(
                    'auto.components.attention.AttentionPage.activeTabNotTerminal',
                    'The active tab is not a terminal.'
                  )}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="pointer-events-auto"
                  onClick={showWorkspace}
                >
                  {translate(
                    'auto.components.attention.AttentionPage.showInWorkspace',
                    'Show it in the workspace'
                  )}
                </Button>
              </div>
            ) : (
              translate(
                'auto.components.attention.AttentionPage.pickSession',
                'Pick a session in the sidebar to work on it here.'
              )
            )
          }
        />
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={translate(
            'auto.components.attention.AttentionPage.resizeSplit',
            'Resize the split'
          )}
          onPointerDown={onResizeStart}
          className={cn(
            'group relative z-10 -mx-0.5 w-1.5 shrink-0 cursor-col-resize',
            isResizing && 'bg-ring/20'
          )}
        >
          <div
            className={cn(
              'mx-auto h-full w-px bg-border transition-colors group-hover:bg-ring/60',
              isResizing && 'bg-ring'
            )}
          />
        </div>
        <AttentionTerminalSlot
          slotId="needs-you"
          label={translate('auto.components.attention.AttentionPage.needsYou', 'Needs you')}
          focused={focusedSlot === 'needs-you'}
          onFocusSlot={focusNeedsYou}
          style={{ flex: `${1 - ratio} 1 0%` }}
          tone="attention"
          pane={needsYou && !slots.sharesCurrentTab ? { paneKey: needsYou.portalPaneKey } : null}
          target={needsYouTarget}
          setTarget={setNeedsYouTarget}
          header={
            needsYou ? (
              <AttentionNeedsYouHeader
                pane={needsYou}
                index={slots.index}
                total={slots.total}
                held={slots.held}
                onPrevious={() => setSelectedPaneKey(stepPane(slots.candidates, slots.index, -1))}
                onNext={() => setSelectedPaneKey(stepPane(slots.candidates, slots.index, 1))}
                onOpenInWorkspace={() => openAttentionPaneInWorkspace(needsYou)}
                action={needsYou.run ? <RunRequestAction pane={needsYou} /> : null}
                trailing={
                  needsYou.paneKey ? <CurrentSessionControls paneKey={needsYou.paneKey} /> : null
                }
              />
            ) : (
              <div className="min-w-0 flex-1 text-sm font-semibold leading-snug text-muted-foreground">
                {translate('auto.components.attention.AttentionPage.needsYou', 'Needs you')}
              </div>
            )
          }
          empty={
            needsYou && slots.sharesCurrentTab
              ? translate(
                  'auto.components.attention.AttentionPage.sharesCurrentTab',
                  'This pane is split inside your current tab, so it is shown on the left.'
                )
              : needsYou && !needsYou.portalPaneKey
                ? translate(
                    'auto.components.attention.AttentionPage.paneUnresolved',
                    'This pane cannot be shown here yet. Open it in its workspace.'
                  )
                : // Why: a blank screen is the point — nothing pulls the eye when nothing is waiting.
                  ''
          }
        />
      </main>
    </div>
  )
}

/** The action of a run's request; its sessions are read only while such a request is in view. */
function RunRequestAction({ pane }: { pane: AttentionPane }): React.JSX.Element | null {
  const sessions = useSidebarSessions()
  return pane.run ? <RunAttentionAction pane={pane} run={pane.run} sessions={sessions} /> : null
}

/** ＋ ⏳ ✓ for the session in view, with what is already queued after it. */
function CurrentSessionControls({ paneKey }: { paneKey: string }): React.JSX.Element | null {
  const sessions = useSidebarSessions()
  const session = useMemo(
    () => sessions.find((candidate) => candidate.paneKey === paneKey) ?? null,
    [paneKey, sessions]
  )
  const chain = useSessionChainForRow(session?.rowKey ?? null)
  if (!session) {
    return null
  }
  return (
    <UpNextControls
      subject={{ kind: 'session', session }}
      status={chain ? <SessionChainStatus chain={chain} session={session} /> : null}
    />
  )
}
