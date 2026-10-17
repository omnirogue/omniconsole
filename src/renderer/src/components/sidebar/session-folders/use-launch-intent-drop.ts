import { useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import {
  LAUNCH_INTENT_DRAG_TYPE,
  getLaunchIntentDrag,
  readLaunchIntentDrag,
  clearLaunchIntentDrag
} from '@/lib/launcher-intent-drag'
import { launchTargetFor, useLaunchContext } from './new-conversation/launch-context'

/** Where a palette provider may be dropped: a session's workspace, or a folder heading. */
export type LaunchIntentDropTarget = { worktreeId: string } | { folderId: string }

/**
 * Why: a paired host opens the conversation there, so no local tab appears. Say where it went
 * instead of leaving the drop to look like it did nothing; a refused launch still gets the
 * launcher's own failure toast.
 */
function announcePairedHostDrop(worktreeId: string): void {
  const state = useAppStore.getState()
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (!isWebRuntimeSessionActive(environmentId)) {
    return
  }
  const host =
    state.runtimeEnvironments?.find((entry) => entry.id === environmentId)?.name ||
    translate('launcherPalette.executionHost', 'its execution host')
  toast.info(translate('launcherPalette.launchingOnHost', 'Launching on {{host}}', { host }))
}

/**
 * Accepts a palette provider drag. A session drop points the launcher at that session's
 * workspace; a folder drop keeps the current target and lets that folder's own "+" file the
 * launch. Either way the mounted launcher starts the pick once its availability has loaded.
 */
export function useLaunchIntentDrop(target: LaunchIntentDropTarget | undefined) {
  const [over, setOver] = useState(false)
  return {
    over,
    onDragOver(event: React.DragEvent<HTMLElement>) {
      if (
        !target ||
        !getLaunchIntentDrag() ||
        !event.dataTransfer.types.includes(LAUNCH_INTENT_DRAG_TYPE)
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      setOver(true)
    },
    onDragLeave(event: React.DragEvent<HTMLElement>) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setOver(false)
      }
    },
    onDrop(event: React.DragEvent<HTMLElement>) {
      setOver(false)
      if (!target || !event.dataTransfer.types.includes(LAUNCH_INTENT_DRAG_TYPE)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const intent = readLaunchIntentDrag(event.dataTransfer)
      clearLaunchIntentDrag()
      if (!intent) {
        return
      }
      const context = useLaunchContext.getState()
      if ('worktreeId' in target) {
        // Target and pending pick change in one update; a refused drop changes neither.
        if (context.requestLaunch(intent, undefined, launchTargetFor(target.worktreeId))) {
          announcePairedHostDrop(target.worktreeId)
        }
        return
      }
      context.requestLaunch(intent, target.folderId)
    }
  }
}
