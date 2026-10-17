import { useCallback, useRef, useState } from 'react'
import { workflowErrorMessage } from '@/lib/console-workflow-client'

export function useWorkflowRequest() {
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) {
      return undefined
    }
    inFlight.current = true
    setPending(true)
    setError(null)
    try {
      return await operation()
    } catch (failure) {
      setError(workflowErrorMessage(failure))
      return undefined
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }, [])
  return { pending, error, run }
}
