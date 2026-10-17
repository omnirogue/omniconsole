import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useLaunchContext, type PendingLaunch } from './new-conversation/launch-context'
import type { LaunchPick } from './new-conversation/resolve-launch-plan'

export const PENDING_LAUNCH_TIMEOUT_MS = 20_000

/**
 * The palette drop this "+" owns: a folder's own "+" owns a folder heading's drop (so the tab
 * is filed there), the toolbar "+" a session row's. `drop` is set while the drop waits and
 * while it launches; the launcher uses `drop.target` instead of the shared target meanwhile, so
 * another launch settling (which resets the shared target) cannot send it to the work root.
 */
export function useOwnedPaletteDrop(folderId: string | undefined, palette: boolean) {
  const pendingLaunch = useLaunchContext((state) => state.pendingLaunch)
  const ownedPending =
    pendingLaunch && pendingLaunch.folderId === folderId && (folderId || palette)
      ? pendingLaunch
      : undefined
  const [launchingDrop, setLaunchingDrop] = useState<PendingLaunch | undefined>()
  return { ownedPending, launchingDrop, setLaunchingDrop, drop: ownedPending ?? launchingDrop }
}

/** Starts the owned drop with the menu row's call once its target's availability has loaded. */
export function useStartOwnedPaletteDrop(args: {
  owned: ReturnType<typeof useOwnedPaletteDrop>
  folderId: string | undefined
  palette: boolean
  loading: boolean
  starting: boolean
  start: (pick: LaunchPick) => void
}): void {
  const { ownedPending, launchingDrop, setLaunchingDrop } = args.owned
  const { folderId, palette } = args
  useEffect(() => {
    if (
      !ownedPending ||
      launchingDrop ||
      args.loading ||
      args.starting ||
      useLaunchContext.getState().pendingLaunch !== ownedPending
    ) {
      return
    }
    useLaunchContext.getState().takePendingLaunch(ownedPending.id)
    setLaunchingDrop(ownedPending)
    args.start(ownedPending.pick)
  })
  // Once the drop's launch has settled, release the target it set (if nobody replaced it).
  const settled = Boolean(launchingDrop) && !args.starting
  useEffect(() => {
    if (!settled || !launchingDrop) {
      return
    }
    useLaunchContext.getState().releaseLaunchTarget(launchingDrop)
    setLaunchingDrop(undefined)
  }, [settled, launchingDrop, setLaunchingDrop])
  // Why: a target whose agents never load must not leave the drop pending forever, silently.
  useEffect(() => {
    if (!ownedPending) {
      return
    }
    const timer = setTimeout(() => {
      const context = useLaunchContext.getState()
      if (context.pendingLaunch !== ownedPending) {
        return
      }
      context.takePendingLaunch(ownedPending.id)
      context.releaseLaunchTarget(ownedPending)
      toast.error(
        translate(
          'launcherPalette.targetUnavailable',
          'Cannot launch here. The workspace or its agents are unavailable.'
        )
      )
    }, PENDING_LAUNCH_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [ownedPending])
  // A waiting drop whose launcher leaves the surface is cancelled with it.
  useEffect(
    () => () => {
      const context = useLaunchContext.getState()
      const pending = context.pendingLaunch
      if (pending && pending.folderId === folderId && (folderId || palette)) {
        context.takePendingLaunch(pending.id)
        context.releaseLaunchTarget(pending)
      }
    },
    [folderId, palette]
  )
}
