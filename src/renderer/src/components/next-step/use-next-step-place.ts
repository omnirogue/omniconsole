import { useEffect, useState } from 'react'
import type { CompanyPlace } from '@/lib/company-place'
import { resolveNextStepPlace } from './next-step-card-filing'

export type NextStepPlaceRead =
  | { phase: 'loading' }
  | { phase: 'ready'; place: CompanyPlace | null }
  | { phase: 'error'; message: string }

/** The company and department this workspace is filed under, read once per workspace. */
export function useNextStepPlace(worktreeId: string | null, enabled = true): NextStepPlaceRead {
  const [read, setRead] = useState<NextStepPlaceRead>({ phase: 'loading' })
  useEffect(() => {
    if (!enabled || !worktreeId) {
      return
    }
    let live = true
    setRead({ phase: 'loading' })
    void resolveNextStepPlace(worktreeId)
      .then((place) => {
        if (live) {
          setRead({ phase: 'ready', place })
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setRead({
            phase: 'error',
            message: cause instanceof Error ? cause.message : String(cause)
          })
        }
      })
    return () => {
      live = false
    }
  }, [enabled, worktreeId])
  return read
}
