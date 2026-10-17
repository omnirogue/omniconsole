import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeEnvironmentSubscriptionHandle } from '../../../preload/api/runtime-api'

// Why this module exists: a remote host republishes a worktree's session.tabs
// frame on every PTY title flip (a spinner-in-title agent flips ~12×/s) and its
// coalescer only merges flips closer than 50 ms, so two busy remote worktrees
// delivered ~32 `updated` frames/s here. The renderer applied every one, and each
// apply re-rendered the whole window, which pinned the main window renderer
// above 100% CPU until its own timers starved. Only the newest snapshotVersion
// per worktree matters, so `updated` frames are throttled per worktree: the first
// one in a quiet window applies at once, later ones wait and only the newest is
// applied, and every pending worktree flushes in one tick so React commits once.
export const WEB_SESSION_TABS_UPDATE_FLUSH_MS = 250

type StreamSubscribe = typeof window.api.runtimeEnvironments.subscribe
type StreamRequest = Parameters<StreamSubscribe>[0]
type StreamCallbacks = Parameters<StreamSubscribe>[1]

export type WebSessionTabsStreamCoalescer = {
  offer: (response: RuntimeRpcResponse<unknown>) => void
  dispose: () => void
}

/** The worktree an `updated` frame may be coalesced under; null delivers in stream order. */
export function webSessionTabsUpdateKey(response: RuntimeRpcResponse<unknown>): string | null {
  if (response.ok === false) {
    return null
  }
  const result = response.result as {
    type?: unknown
    worktree?: unknown
    removed?: unknown
  } | null
  // Why: a removal fences later frames, so it must never be folded into or behind one.
  if (
    result?.type !== 'updated' ||
    typeof result.worktree !== 'string' ||
    result.removed === true
  ) {
    return null
  }
  return result.worktree
}

export function createWebSessionTabsStreamCoalescer(
  deliver: (response: RuntimeRpcResponse<unknown>) => void,
  options: { flushMs?: number } = {}
): WebSessionTabsStreamCoalescer {
  const flushMs = options.flushMs ?? WEB_SESSION_TABS_UPDATE_FLUSH_MS
  const pending = new Map<string, RuntimeRpcResponse<unknown>>()
  const deliveredAt = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.size === 0) {
      return
    }
    const frames = [...pending]
    pending.clear()
    const now = Date.now()
    for (const [key, response] of frames) {
      deliveredAt.set(key, now)
      deliver(response)
    }
  }

  return {
    offer(response) {
      if (disposed) {
        return
      }
      const key = webSessionTabsUpdateKey(response)
      if (key === null) {
        // Why: snapshots, inventories, removals and stream end keep their place in the stream.
        flush()
        deliver(response)
        return
      }
      const now = Date.now()
      const last = deliveredAt.get(key)
      if (!pending.has(key) && (last === undefined || now - last >= flushMs)) {
        deliveredAt.set(key, now)
        deliver(response)
        return
      }
      pending.set(key, response)
      if (!timer) {
        timer = setTimeout(flush, Math.max(0, (last ?? now) + flushMs - now))
      }
    },
    dispose() {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      pending.clear()
    }
  }
}

/** `window.api.runtimeEnvironments.subscribe` for a session.tabs stream, with `updated` frames throttled per worktree. */
export async function subscribeWebSessionTabsStream(
  request: StreamRequest,
  callbacks: StreamCallbacks
): Promise<RuntimeEnvironmentSubscriptionHandle> {
  const coalescer = createWebSessionTabsStreamCoalescer(callbacks.onResponse)
  const handle = await window.api.runtimeEnvironments.subscribe(request, {
    ...callbacks,
    onResponse: coalescer.offer
  })
  return {
    ...handle,
    unsubscribe: () => {
      coalescer.dispose()
      handle.unsubscribe()
    }
  }
}
