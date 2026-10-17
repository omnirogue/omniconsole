import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  deriveHostResourceView,
  type HostResourceReading
} from '../../../../shared/host-resource-model'
import {
  hostLoadBandToneClass,
  hostResourceBadgeParts,
  hostResourceTooltip,
  hostResourceUnavailableText
} from './host-resource-copy'
import { useHostResourceClock, useHostResourceReading } from './host-resource-poller'

/**
 * `12 GB · 0.3/core · 4` with the load tinted by band; a dash when the host has not answered.
 * Pure display: the caller supplies the reading (see `useHostResourceReading`).
 */
export function HostResourceBadge({
  reading,
  className
}: {
  reading: HostResourceReading | null
  className?: string
}): React.JSX.Element | null {
  const now = useHostResourceClock()
  if (!reading || reading.state === 'checking') {
    return null
  }
  const view = deriveHostResourceView(reading, now)
  const tooltip = view ? hostResourceTooltip(view) : hostResourceUnavailableText(reading.detail)
  const parts = view ? hostResourceBadgeParts(view) : null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] leading-none tabular-nums text-muted-foreground',
            className
          )}
          aria-label={tooltip}
          data-host-resource-badge={reading.hostKey}
        >
          {parts && view ? (
            <>
              <span>{parts.memory}</span>
              <span aria-hidden>·</span>
              <span className={hostLoadBandToneClass(view.band)}>{parts.load}</span>
              <span aria-hidden>·</span>
              <span>{parts.sessions}</span>
            </>
          ) : (
            <span>–</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

/** Polls while shown and only while the host is connected; a disconnected host shows nothing. */
export function LiveHostResourceBadge({
  hostKey,
  connected,
  className
}: {
  hostKey: string
  connected: boolean
  className?: string
}): React.JSX.Element | null {
  const reading = useHostResourceReading(connected ? hostKey : null)
  return connected ? <HostResourceBadge reading={reading} className={className} /> : null
}
