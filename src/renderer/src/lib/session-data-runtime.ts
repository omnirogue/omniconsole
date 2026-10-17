import { useCallback, useSyncExternalStore } from 'react'

type RuntimeBridge = Window['api']
type RuntimeIdentity = {
  key: string
  observed: boolean
  checking: Promise<void> | null
  listeners: Set<() => void>
  focus: () => void
}
const identities = new WeakMap<RuntimeBridge, RuntimeIdentity>()
let nextBridge = 0
function bridge(): RuntimeBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.api
}
function identity(api: RuntimeBridge): RuntimeIdentity {
  let state = identities.get(api)
  if (!state) {
    state = {
      key: `local-bridge:${++nextBridge}`,
      observed: false,
      checking: null,
      listeners: new Set(),
      focus: () => {
        void refreshIdentity(api)
      }
    }
    identities.set(api, state)
  }
  return state
}

async function refreshIdentity(api: RuntimeBridge): Promise<void> {
  const state = identity(api)
  if (state.checking) {
    return state.checking
  }
  if (!api.runtime?.getStatus) {
    return
  }
  state.checking = Promise.resolve()
    .then(() => api.runtime.getStatus())
    .then((status) => {
      if (bridge() !== api || !status.runtimeId) {
        return
      }
      const key = `local:${status.runtimeId}`
      if (key !== state.key) {
        state.key = key
        state.listeners.forEach((listener) => listener())
      }
      state.observed = true
    })
    .catch(() => {
      // Queue reads still report the outage; an unobserved bridge stays isolated from other runtimes.
    })
    .finally(() => {
      state.checking = null
    })
  return state.checking
}

export function localSessionDataRuntimeKey(): string {
  const api = bridge()
  return api ? identity(api).key : 'local'
}

export async function ensureSessionDataRuntime(): Promise<void> {
  const api = bridge()
  if (api) {
    const state = identity(api)
    if (state.checking) {
      await state.checking
    } else if (!state.observed) {
      await refreshIdentity(api)
    }
  }
}

function subscribe(api: RuntimeBridge | undefined, listener: () => void): () => void {
  if (!api) {
    return () => {}
  }
  const state = identity(api)
  state.listeners.add(listener)
  if (state.listeners.size === 1) {
    window.addEventListener('focus', state.focus)
    void refreshIdentity(api)
  }
  return () => {
    state.listeners.delete(listener)
    if (state.listeners.size === 0) {
      window.removeEventListener('focus', state.focus)
    }
  }
}

export function useSessionDataRuntimeKey(): string {
  const api = bridge()
  const listen = useCallback((listener: () => void) => subscribe(api, listener), [api])
  return useSyncExternalStore(listen, localSessionDataRuntimeKey, localSessionDataRuntimeKey)
}
