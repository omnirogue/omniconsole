import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { installWindowVisibilitySubscriptionParking } from '@/runtime/window-visibility-subscription-parking'
import { persistLocalWorkflowConversationAnchor } from '@/lib/local-workflow-conversation'
import {
  LOCAL_WORKFLOW_METHODS,
  type LocalWorkflowReadCallResult,
  type LocalWorkflowSetupRequest,
  type LocalWorkflowSetupResult,
  type LocalWorkflowShowResult,
  type LocalWorkflowWatchEvent
} from '../../../../shared/local-workflow-rpc'
import { localWorkflowChangedEvent } from '../../../../shared/local-workflow-changed'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'

/** Only when the push stream cannot be opened; the host pushes every change otherwise. */
export const LOCAL_WORKFLOW_FALLBACK_POLL_MS = 10_000
const SETUP_REFRESH_MS = 60_000

type CallLogs = Record<string, { attempt: number; logs: LocalWorkflowReadCallResult }>
/** A push is the stream's latest word; a reply (show, control) may have left the host earlier. */
export type LocalWorkflowViewOrigin = 'push' | 'reply'
const SETTLED_CALLS = new Set(['completed', 'failed', 'cancelled', 'unverifiable'])
type Projection = {
  key: string
  setup?: LocalWorkflowSetupResult
  view?: LocalWorkflowView
  logs?: CallLogs
  loading: boolean
  error?: string
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Pushed views carry no logs; logs read on demand stay attached to the attempt they came from.
 * While a retry is still running they are that call's only logs, so they stay until it settles.
 */
function withLogs(view: LocalWorkflowView | undefined, logs: CallLogs | undefined) {
  if (!view || !logs) {
    return view
  }
  return {
    ...view,
    calls: view.calls.map((call) => {
      const attached = logs[call.id]
      const current =
        attached &&
        (attached.attempt === call.attempt ||
          (attached.attempt < call.attempt && !SETTLED_CALLS.has(call.state)))
      return current ? { ...call, ...attached.logs } : call
    })
  }
}

function compareViews(left: LocalWorkflowView, right: LocalWorkflowView): number {
  return left.fence - right.fence || left.sequence - right.sequence
}

export function useLocalWorkflowProjection(
  request: LocalWorkflowSetupRequest,
  worktreeId: string,
  executionId: string | undefined,
  enabled: boolean
): Omit<Projection, 'key' | 'logs'> & {
  accept: (view: LocalWorkflowView, origin?: LocalWorkflowViewOrigin) => void
  attachLogs: (callId: string, attempt: number, logs: LocalWorkflowReadCallResult) => void
} {
  const { worktree, conversationId, preset } = request
  const key = JSON.stringify([worktree, conversationId, preset, executionId])
  const latestKey = useRef(key)
  useLayoutEffect(() => {
    latestKey.current = key
  }, [key])
  const [data, setData] = useState<Projection>({ key, loading: true })
  const known = useRef<
    { key: string; view: LocalWorkflowView; origin: LocalWorkflowViewOrigin } | undefined
  >(undefined)
  const accept = useCallback(
    (view: LocalWorkflowView, origin: LocalWorkflowViewOrigin = 'reply') => {
      if (latestKey.current !== key) {
        return
      }
      if (view.executionId !== executionId || view.preset !== preset) {
        throw new Error('Workflow projection belongs to a different execution.')
      }
      const previous = known.current?.key === key ? known.current : undefined
      const order = previous ? compareViews(view, previous.view) : 1
      // Why: a slower show or control reply must never roll a view back. Live-only changes keep
      // the sequence, so at an equal sequence only the stream (or a reply to a reply) may replace.
      if (order < 0 || (order === 0 && origin === 'reply' && previous?.origin === 'push')) {
        return
      }
      known.current = { key, view, origin }
      setData((current) => ({
        ...(current.key === key ? current : { key }),
        view,
        loading: false,
        error: undefined
      }))
      useAppStore.getState().setLocalWorkflowStatus(localWorkflowChangedEvent(view, conversationId))
    },
    [key, executionId, preset, conversationId]
  )
  const attachLogs = useCallback(
    (callId: string, attempt: number, logs: LocalWorkflowReadCallResult) => {
      setData((current) =>
        current.key === key
          ? { ...current, logs: { ...current.logs, [callId]: { attempt, logs } } }
          : current
      )
    },
    [key]
  )

  useEffect(() => {
    if (!enabled) {
      return
    }
    return installWindowVisibilitySubscriptionParking([
      {
        subscribe: async (isCurrent) => {
          let pending = false
          let anchorPersisted = false
          const fail = (cause: unknown) => {
            if (!isCurrent()) {
              return
            }
            // The stream stopped speaking, so the next poll reply may replace its last view.
            if (known.current?.key === key) {
              known.current = { ...known.current, origin: 'reply' }
            }
            setData((previous) => ({
              ...(previous.key === key ? previous : { key }),
              loading: false,
              error: message(cause),
              ...(previous.key === key && previous.view
                ? { view: { ...previous.view, connection: 'disconnected' } }
                : {})
            }))
          }
          const persistAnchor = async () => {
            if (!anchorPersisted) {
              await persistLocalWorkflowConversationAnchor(worktreeId, conversationId)
              anchorPersisted = true
            }
          }
          const read = async () => {
            if (pending || !isCurrent()) {
              return
            }
            pending = true
            try {
              await persistAnchor()
              if (executionId) {
                const view = await callRuntimeRpc<LocalWorkflowShowResult>(
                  { kind: 'local' },
                  LOCAL_WORKFLOW_METHODS.show,
                  { worktree, conversationId, executionId }
                )
                if (isCurrent()) {
                  accept(view)
                }
              } else {
                const setup = await callRuntimeRpc<LocalWorkflowSetupResult>(
                  { kind: 'local' },
                  LOCAL_WORKFLOW_METHODS.setup,
                  { worktree, conversationId, preset }
                )
                if (isCurrent()) {
                  setData({ key, setup, loading: false })
                }
              }
            } catch (cause) {
              fail(cause)
            } finally {
              pending = false
            }
          }
          if (!executionId) {
            await read()
            const timer = setInterval(() => void read(), SETUP_REFRESH_MS)
            return { unsubscribe: () => clearInterval(timer) }
          }
          let fallback: ReturnType<typeof setInterval> | undefined
          const poll = () => {
            if (!fallback) {
              fallback = setInterval(() => void read(), LOCAL_WORKFLOW_FALLBACK_POLL_MS)
              void read()
            }
          }
          let stream: { unsubscribe: () => void } | undefined
          try {
            await persistAnchor()
            stream = await window.api.runtime.subscribe(
              {
                method: LOCAL_WORKFLOW_METHODS.watch,
                params: { worktree, conversationId, executionId }
              },
              (response) => {
                if (!isCurrent()) {
                  return
                }
                try {
                  if (!response.ok) {
                    throw new Error(response.error.message)
                  }
                  const event = response.result as LocalWorkflowWatchEvent
                  if (event?.type === 'view') {
                    accept(event.view, 'push')
                  }
                } catch (cause) {
                  fail(cause)
                  poll()
                }
              }
            )
          } catch {
            // The stream could not open; a slow poll keeps the view honest until it can.
            poll()
          }
          return {
            unsubscribe: () => {
              stream?.unsubscribe()
              if (fallback) {
                clearInterval(fallback)
              }
            }
          }
        }
      }
    ])
  }, [enabled, key, executionId, worktree, worktreeId, conversationId, preset, accept])
  const current = data.key === key ? data : undefined
  const view = useMemo(() => withLogs(current?.view, current?.logs), [current?.view, current?.logs])
  return {
    ...(current
      ? { setup: current.setup, loading: current.loading, error: current.error, view }
      : { loading: true }),
    accept,
    attachLogs
  }
}
