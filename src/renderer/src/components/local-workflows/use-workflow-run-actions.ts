import { useRef, useState } from 'react'
import type { LocalWorkflowSaveResult } from '../../../../shared/local-workflow-rpc'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'

export type LocalWorkflowSavedResult = Extract<LocalWorkflowSaveResult, { saved: true }>

/**
 * One host action at a time (control, save, new turn); errors stay on screen and a save receipt
 * only ever belongs to the execution that produced it.
 */
export function useWorkflowRunActions(
  view: Pick<LocalWorkflowView, 'executionId' | 'connection'>,
  onSaveResult?: () => Promise<LocalWorkflowSaveResult>
) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState<LocalWorkflowSavedResult>()
  const submitting = useRef(false)
  const connected = view.connection === 'connected'
  const perform = async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    if (submitting.current || !connected) {
      return undefined
    }
    submitting.current = true
    setPending(true)
    setError(undefined)
    try {
      return await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    } finally {
      submitting.current = false
      setPending(false)
    }
  }
  // Why: the receipt is applied after perform settles, so the queued action stays side-effect free.
  const save = onSaveResult
    ? async () => {
        const receipt = await perform(onSaveResult)
        if (receipt?.saved) {
          setSaved(receipt)
        }
      }
    : undefined
  return {
    pending,
    error,
    connected,
    savedResult: saved?.executionId === view.executionId ? saved : undefined,
    perform,
    save
  }
}
