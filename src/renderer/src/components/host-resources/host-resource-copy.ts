import { translate } from '@/i18n/i18n'
import {
  formatBadgeGb,
  formatDetailGb,
  formatLoadPerCore,
  type HostLoadBand,
  type HostResourceView
} from '../../../../shared/host-resource-model'

/** Same green/amber/red text tones as the host usage bars (`usageTextColorClass`). */
export function hostLoadBandToneClass(band: HostLoadBand): string {
  switch (band) {
    case 'hot':
      return 'text-red-500'
    case 'offload':
      return 'text-yellow-500'
    case 'ok':
      return 'text-emerald-500'
  }
}

export function hostLoadBandLabel(band: HostLoadBand): string {
  switch (band) {
    case 'hot':
      return translate('hostResources.bandHot', 'Hot')
    case 'offload':
      return translate('hostResources.bandOffload', 'Offload')
    case 'ok':
      return translate('hostResources.bandOk', 'OK')
  }
}

/** "12 GB", "0.3/core", "4" — the badge's three parts. */
export function hostResourceBadgeParts(view: HostResourceView): {
  memory: string
  load: string
  sessions: string
} {
  return {
    memory: translate('hostResources.badgeMemory', '{{free}} GB', {
      free: formatBadgeGb(view.freeGb)
    }),
    load: translate('hostResources.badgeLoad', '{{load}}/core', {
      load: formatLoadPerCore(view.loadPerCore)
    }),
    sessions: view.liveSessions === null ? '–' : String(view.liveSessions)
  }
}

function ageText(ageSeconds: number | null): string | null {
  if (ageSeconds === null) {
    return null
  }
  return ageSeconds < 90
    ? translate('hostResources.updatedSeconds', 'updated {{count}} s ago', { count: ageSeconds })
    : translate('hostResources.updatedMinutes', 'updated {{count}} min ago', {
        count: Math.round(ageSeconds / 60)
      })
}

/** "12.4 GB free of 32 GB · load 3.2 on 10 cores (OK) · 4 live sessions · updated 12 s ago" */
export function hostResourceTooltip(view: HostResourceView): string {
  const parts = [
    translate('hostResources.tooltipMemory', '{{free}} GB free of {{total}} GB', {
      free: formatDetailGb(view.freeGb),
      total: formatDetailGb(view.totalGb)
    }),
    translate('hostResources.tooltipLoad', 'load {{load}} on {{cores}} cores ({{band}})', {
      load: view.loadAverage1m.toFixed(1),
      cores: view.cpuCoreCount,
      band: hostLoadBandLabel(view.band)
    }),
    view.liveSessions === null
      ? translate('hostResources.tooltipSessionsUnknown', 'live sessions unknown')
      : view.liveSessions === 1
        ? translate('hostResources.tooltipSessionsOne', '1 live session')
        : translate('hostResources.tooltipSessions', '{{count}} live sessions', {
            count: view.liveSessions
          }),
    ageText(view.ageSeconds)
  ]
  return parts.filter((part): part is string => Boolean(part)).join(' · ')
}

export function hostResourceUnavailableText(detail: string | undefined): string {
  return detail
    ? translate('hostResources.unavailableDetail', 'Resources unavailable: {{detail}}', { detail })
    : translate('hostResources.unavailable', 'Resources unavailable')
}
