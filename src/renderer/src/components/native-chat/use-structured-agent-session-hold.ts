// The desktop chat telling main that this session is on screen.
//
// A structured chat is an in-place view on a terminal tab, so closing the tab unmounts this and
// nothing else in the close path knows a provider process is involved: `closeUnifiedTab` retires
// the PTY and drops the tab, main hears nothing, and a codex app-server outlives the chat for the
// rest of the app's life. Surface activity is the honest signal — it covers closing the tab,
// closing the window, and visibility changes for retained panes, none of which share a code path.
//
// The release CHAINS off the hold rather than racing it: an unmount during the hold's round trip
// would otherwise release a hold that has not landed yet, and the late hold would never be undone.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  acquireStructuredViewerHold,
  observeStructuredViewerProcess,
  type StructuredViewerHoldResult
} from '@/runtime/structured-agent-viewer-hold'

let holderOrdinal = 0

export function structuredAgentSessionHolderId(surface: string): string {
  holderOrdinal += 1
  return `${surface}:${holderOrdinal}`
}

export function useStructuredAgentSessionHold(args: {
  sessionId: string
  target: RuntimeClientTarget
  surface: string
  enabled?: boolean
  mode?: 'viewer'
}) {
  const { enabled = true, sessionId, surface, target, mode } = args
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{
    key: object
    state: StructuredViewerHoldResult
    error: string | null
  } | null>(null)
  const active = useRef<{ key: object; target: RuntimeClientTarget } | null>(null)
  const resuming = useRef<object | null>(null)
  const commandCenter = useAppStore((state) => state.settings?.commandCenter === true)
  const windowVisible = useSyncExternalStore(
    commandCenter ? subscribeWindowParkVisibility : () => () => {},
    commandCenter ? getWindowParkVisible : () => true,
    () => true
  )
  const visible = enabled && windowVisible
  // Keyed by VALUE, not identity: callers build the target inline, so an identity dependency would
  // release and re-take the hold on every render of the pane.
  const targetKey = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
  const targetRef = useRef(target)
  // Synced in an effect declared first (so it lands before the hold below) rather than in render:
  // a render React discards must not leak its target into the next commit.
  useEffect(() => {
    targetRef.current = target
  }, [target])
  // Restoring a pane must wait for fresh hold proof before dispatching queued input.
  const key = useMemo(
    () => ({ targetKey, sessionId, mode, revision, visible }),
    [targetKey, sessionId, mode, revision, visible]
  )
  useEffect(() => {
    if (!visible) {
      return
    }
    let current = true
    const generation = { key, target: targetRef.current }
    active.current = generation
    const runtimeTarget = generation.target
    let stopObserving: (() => void) | undefined
    const holderId = structuredAgentSessionHolderId(surface)
    const held =
      mode === 'viewer'
        ? acquireStructuredViewerHold(runtimeTarget, sessionId, holderId, () => current)
        : callStructuredAgentSession(runtimeTarget, 'agentSession.hold', {
            sessionId,
            holderId
          }).then(() => ({ processState: 'live' as const, fallback: false }))
    void held
      .then((state) => {
        if (current && state) {
          setResult({ key, state, error: null })
          if (mode === 'viewer' && !state.fallback) {
            stopObserving = observeStructuredViewerProcess(
              runtimeTarget,
              sessionId,
              (processState) => {
                if (current) {
                  setResult({ key, state: { processState, fallback: false }, error: null })
                }
              }
            )
          }
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setResult({
            key,
            state: { processState: 'unverifiable', fallback: false },
            error:
              error instanceof Error ? error.message : 'The session hold could not be confirmed.'
          })
        }
      })
    return () => {
      current = false
      if (active.current === generation) {
        active.current = null
      }
      stopObserving?.()
      // Also release an uncertain hold: a timeout does not prove the host rejected it.
      const release = () =>
        callStructuredAgentSession(runtimeTarget, 'agentSession.release', {
          sessionId,
          holderId
        }).catch((error: unknown) =>
          console.warn('[structured-session] Hold release could not be confirmed', error)
        )
      void held.then((state) => (state === null ? undefined : release()), release)
    }
  }, [visible, sessionId, surface, targetKey, mode, key])
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const resume = useCallback(async (): Promise<boolean> => {
    const generation = active.current
    if (
      !generation ||
      generation.key !== key ||
      resuming.current ||
      mode !== 'viewer' ||
      result?.key !== key ||
      result.state.processState !== 'exited' ||
      result.state.fallback
    ) {
      return false
    }
    const attempt = {}
    resuming.current = attempt
    const runtimeTarget = generation.target
    const holderId = structuredAgentSessionHolderId(`${surface}:resume`)
    try {
      // A temporary resume-capable holder leaves the viewer's retention passive.
      await callStructuredAgentSession(runtimeTarget, 'agentSession.hold', { sessionId, holderId })
      if (active.current === generation) {
        setResult({ key, state: { processState: 'live', fallback: false }, error: null })
      }
      return true
    } catch (error) {
      if (active.current === generation) {
        setResult({
          key,
          state: { processState: 'unverifiable', fallback: false },
          error: error instanceof Error ? error.message : 'Resume could not be confirmed.'
        })
      }
      return false
    } finally {
      if (resuming.current === attempt) {
        resuming.current = null
      }
      void callStructuredAgentSession(runtimeTarget, 'agentSession.release', {
        sessionId,
        holderId
      }).catch((error: unknown) =>
        console.warn('[structured-session] Resume hold release could not be confirmed', error)
      )
    }
  }, [mode, sessionId, surface, key, result])
  return {
    processState:
      result?.key === key && visible ? result.state.processState : ('checking' as const),
    fallback: result?.key === key && result.state.fallback,
    error: result?.key === key ? result.error : null,
    resume,
    refresh
  }
}
