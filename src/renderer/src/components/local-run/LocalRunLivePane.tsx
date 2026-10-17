import { useCallback, useId, useLayoutEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { setActivityTerminalPortals } from '../activity/activity-terminal-portal'
import { findTerminalHandleTarget } from '../terminal-pane/terminal-handle-links'
import { localRunPanePortalDescriptors } from './local-run-live-pane'

/**
 * The running node's own terminal, shown inside the canvas. It borrows the live
 * TerminalPane through the activity portal seam the Attention view uses, so the pane
 * moves rather than being duplicated: no second PTY, no second xterm, no copied output.
 */
export function LocalRunLivePane({
  handle,
  owner = 'localRuns'
}: {
  handle: string | null
  owner?: string
}) {
  const instanceId = useId()
  const portalOwner = `${owner}:${instanceId}`
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((state) => state.ptyIdsByTabId)
  const terminalLayoutsByTabId = useAppStore((state) => state.terminalLayoutsByTabId)
  const target = useMemo(
    () =>
      handle
        ? findTerminalHandleTarget(handle, {
            tabsByWorktree,
            ptyIdsByTabId,
            terminalLayoutsByTabId
          })
        : null,
    [handle, tabsByWorktree, ptyIdsByTabId, terminalLayoutsByTabId]
  )
  const descriptors = useMemo(
    () => localRunPanePortalDescriptors({ handle, target, element, active: true }),
    [handle, target, element]
  )
  // Why useLayoutEffect: publish before paint, so the portal subscriber re-renders in
  // the same commit and the slot never flashes a different terminal.
  useLayoutEffect(() => {
    setActivityTerminalPortals(descriptors, portalOwner)
  }, [descriptors, portalOwner])
  const release = useCallback(
    (node: HTMLDivElement | null): void => {
      setElement(node)
      if (!node) {
        setActivityTerminalPortals([], portalOwner)
      }
    },
    [portalOwner]
  )
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">
        {translate('auto.components.local-run.LivePane.title', 'Live pane')}
      </h3>
      <div
        ref={release}
        aria-label={translate('auto.components.local-run.LivePane.slot', 'Live pane for this step')}
        className="h-64 min-w-0 overflow-hidden rounded-md border border-border bg-background"
      />
      {!target && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.local-run.LivePane.unavailable',
            'This step has no live terminal on this computer right now.'
          )}
        </p>
      )}
    </div>
  )
}
