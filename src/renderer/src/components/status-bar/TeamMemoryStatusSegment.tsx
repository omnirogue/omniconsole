import React, { useCallback, useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
import type { TeamMemoryStatusView } from '../../../../shared/team-memory-contract'
import { teamMemoryStatusCopy } from './team-memory-status-copy'

/** Main keeps the answer and pushes changes; this only reads and re-asks on click. */
export function useTeamMemoryStatus(): [TeamMemoryStatusView, () => void] {
  const [status, setStatus] = useState<TeamMemoryStatusView>({ state: 'unknown' })
  useEffect(() => {
    const api = window.api.teamMemory
    if (!api) {
      return
    }
    let disposed = false
    void api.status().then((current) => {
      if (!disposed) {
        setStatus(current)
      }
    })
    const unsubscribe = api.onStatus((next) => setStatus(next))
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])
  const refresh = useCallback(() => {
    void window.api.teamMemory?.refresh().then(setStatus)
  }, [])
  return [status, refresh]
}

export function TeamMemoryStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const [status, refresh] = useTeamMemoryStatus()
  if (!window.api.teamMemory) {
    return null
  }
  const copy = teamMemoryStatusCopy(status)
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex cursor-pointer items-center rounded hover:bg-accent/70"
          aria-label={copy.label}
        >
          <IntegrationStatusPill tone={copy.tone}>
            {iconOnly ? null : <span className="max-w-[26ch] truncate">{copy.label}</span>}
          </IntegrationStatusPill>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-xs">
        <div className="font-medium">{copy.label}</div>
        <div>{copy.detail}</div>
      </TooltipContent>
    </Tooltip>
  )
}
