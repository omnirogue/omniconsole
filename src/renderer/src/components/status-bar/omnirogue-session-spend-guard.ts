import { useEffect, useState } from 'react'
import type { OmniRogueSessionSpend } from '../../../../preload/api/omnirogue-api'
import type { OmniRogueSpendGuardLimit } from './omnirogue-spend-guard-helpers'

/** Sessions with a budget become session limits; reserved credits count as spent. */
export function sessionSpendGuardLimits(
  sessions: readonly OmniRogueSessionSpend[]
): OmniRogueSpendGuardLimit[] {
  return sessions.flatMap((session) =>
    session.budgetCredits === null
      ? []
      : [
          {
            period: 'session' as const,
            limitCredits: session.budgetCredits,
            spentCredits: session.spentCredits + session.reservedCredits
          }
        ]
  )
}

/** Follows the main-process W5-38 ledger while mounted; empty until a session has spend. */
export function useOmniRogueSessionSpend(): OmniRogueSessionSpend[] {
  const [sessions, setSessions] = useState<OmniRogueSessionSpend[]>([])
  useEffect(() => {
    const api = window.api?.omnirogue?.spend
    if (!api) {
      return
    }
    let active = true
    void api
      .listSessions()
      .then((next) => {
        if (active) {
          setSessions(next)
        }
      })
      .catch(() => undefined)
    const unsubscribe = api.onSessionChanged((spend) => {
      if (active) {
        setSessions((current) => [
          spend,
          ...current.filter((entry) => entry.sessionId !== spend.sessionId)
        ])
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  return sessions
}
