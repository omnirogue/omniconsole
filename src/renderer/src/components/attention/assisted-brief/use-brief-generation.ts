import { useCallback, useEffect, useRef, useState } from 'react'
import type { BriefActor } from '../../../../../shared/assisted-brief-types'
import { cancelBriefGeneration, runBriefGeneration } from './assisted-brief-runner-client'
import type { BriefWorkspace } from './assisted-brief-workspace'

export type BriefGenerationRun = { purpose: 'draft' | 'challenge'; actor: BriefActor }

/**
 * One draft or review at a time. The in-flight run's workspace is kept in a ref as well as
 * state, so a second click during the same render cannot start a second run, and closing the
 * view stops the run instead of leaving it on the workspace's lane.
 */
export function useBriefGeneration(workspace: BriefWorkspace) {
  const [running, setRunning] = useState<BriefGenerationRun | null>(null)
  const [error, setError] = useState('')
  const inFlight = useRef<BriefWorkspace | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // Why: its reply would be dropped, and a reopened view could start a second run on the same lane.
      if (inFlight.current) {
        cancelBriefGeneration(inFlight.current)
      }
    }
  }, [])

  /** Resolves to the model's reply, or null when the run failed, was cancelled or the view closed. */
  const run = useCallback(
    async (next: BriefGenerationRun, prompt: string): Promise<string | null> => {
      if (inFlight.current) {
        return null
      }
      inFlight.current = workspace
      setRunning(next)
      setError('')
      const result = await runBriefGeneration({
        workspace,
        purpose: next.purpose,
        actor: next.actor,
        prompt
      })
      inFlight.current = null
      if (!alive.current) {
        return null
      }
      setRunning(null)
      if (!result.ok) {
        if (!result.canceled) {
          setError(result.error)
        }
        return null
      }
      return result.text
    },
    [workspace]
  )

  const cancel = useCallback(() => cancelBriefGeneration(workspace), [workspace])

  return { running, error, setError, run, cancel }
}

export type BriefGeneration = ReturnType<typeof useBriefGeneration>
