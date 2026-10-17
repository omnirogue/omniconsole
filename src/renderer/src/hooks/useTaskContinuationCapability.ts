import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

type Capability = { available: boolean; openrouterRouting?: boolean; reason?: string }
type Snapshot = Capability & { owner: string; loading: boolean }

/** Task admission support belongs to this task and signed person, not the installed app. */
export function useTaskContinuationCapability(scope: string, enabled: boolean, taskId?: string) {
  const api = window.api?.consoleLocalExecution
  const supported =
    enabled &&
    Boolean(taskId) &&
    typeof api?.continueTask === 'function' &&
    typeof api?.taskContinuationCapabilities === 'function'
  const owner = JSON.stringify([scope, supported, taskId])
  const currentOwner = useRef(owner)
  useLayoutEffect(() => {
    currentOwner.current = owner
  }, [owner])
  const requestId = useRef(0)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const refresh = useCallback(async (): Promise<Capability> => {
    if (!supported || !api?.taskContinuationCapabilities) {
      setSnapshot(null)
      return { available: false }
    }
    const id = ++requestId.current
    setSnapshot({ owner, available: false, loading: true })
    let capability: Capability = { available: false }
    try {
      const result = await api.taskContinuationCapabilities({ taskId })
      if (
        result?.ok === true &&
        result.data &&
        typeof result.data === 'object' &&
        !Array.isArray(result.data) &&
        typeof result.data.available === 'boolean' &&
        (result.data.reason === undefined || typeof result.data.reason === 'string')
      ) {
        capability = {
          available: result.data.available === true,
          openrouterRouting: result.data.openrouter_routing === true,
          ...(typeof result.data.reason === 'string' ? { reason: result.data.reason } : {})
        }
      }
    } catch {
      // Missing or failed negotiation is never permission to offer task execution.
    }
    if (currentOwner.current !== owner || requestId.current !== id) {
      return { available: false }
    }
    setSnapshot({ owner, ...capability, loading: false })
    return capability
  }, [api, owner, supported, taskId])
  useEffect(() => {
    void refresh()
    return () => {
      requestId.current += 1
    }
  }, [refresh])
  const current = supported && snapshot?.owner === owner ? snapshot : null
  return {
    available: current?.available === true,
    openrouterRouting: current?.openrouterRouting === true,
    reason: current?.reason,
    loading: supported && (!current || current.loading),
    refresh
  }
}
