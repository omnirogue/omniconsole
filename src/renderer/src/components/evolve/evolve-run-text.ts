import { translate } from '@/i18n/i18n'
import type { EvolveRunState, EvolveWorkerVerdict } from '../../../../shared/evolve-workflow'

export function evolveStateLabel(state: EvolveRunState): string {
  switch (state) {
    case 'starting':
      return translate('evolve.state.starting', 'Starting')
    case 'running':
      return translate('evolve.state.running', 'Running')
    case 'done':
      return translate('evolve.state.done', 'Done')
    case 'failed':
      return translate('evolve.state.failed', 'Failed')
    case 'stopped':
      return translate('evolve.state.stopped', 'Stopped')
    case 'unverifiable':
      return translate('evolve.state.unverifiable', 'Unverifiable')
  }
}

export function evolveStateVariant(
  state: EvolveRunState
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (state) {
    case 'done':
      return 'default'
    case 'failed':
      return 'destructive'
    case 'stopped':
      return 'secondary'
    case 'starting':
    case 'running':
    case 'unverifiable':
      return 'outline'
  }
}

export function evolveVerdictLabel(verdict: EvolveWorkerVerdict): string {
  switch (verdict) {
    case 'live':
      return translate('evolve.verdict.live', 'live')
    case 'unverifiable':
      return translate('evolve.verdict.unverifiable', 'unverifiable')
    case 'exited':
      return translate('evolve.verdict.exited', 'exited')
  }
}

export function evolveScore(score: number | null | undefined): string {
  return typeof score === 'number' ? score.toFixed(4) : '—'
}

export function evolveUsd(value: number | null | undefined): string {
  return typeof value === 'number' ? `$${value.toFixed(2)}` : '—'
}

export function evolveYesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return '—'
  }
  return value ? translate('evolve.yes', 'yes') : translate('evolve.no', 'no')
}

export function evolveAge(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number') {
    return '—'
  }
  const rounded = Math.max(0, Math.round(seconds))
  return rounded < 120
    ? translate('evolve.ageSeconds', '{{count}} s ago', { count: rounded })
    : translate('evolve.ageMinutes', '{{count}} min ago', { count: Math.round(rounded / 60) })
}

export function evolveTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
