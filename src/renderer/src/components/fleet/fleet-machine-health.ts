import { translate } from '@/i18n/i18n'
import type { ConsoleConversationFleetMachine } from '../../../../shared/console-conversation-fleet-types'

/**
 * One fleet machine as a person reads it: what it is doing now and whether it can take
 * this work. Health numbers are optional on purpose — the console fills them from the
 * runner heartbeat, and a console that does not report them yet must not be guessed for.
 */
export type FleetMachineHealth = {
  host: string
  /** Whether this machine may be chosen for new work. */
  available: boolean
  /** Why it cannot be chosen, in words; null when it can. */
  reason: string | null
  cores: number | null
  load1: number | null
  /** Load per core, 0…1+, when both numbers are known. */
  ratio: number | null
  slots: number
  running: number
  freeSlots: number
  memUsedBytes: number | null
  memTotalBytes: number | null
  /** "claude · signed in", "codex · signed out" — one line per provider it offers. */
  agents: { provider: string; available: boolean; detail: string }[]
  lastBeat: string | null
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function fleetMachineHealth(machine: ConsoleConversationFleetMachine): FleetMachineHealth {
  const cores = finite(machine.cores)
  const load1 = finite(machine.load1)
  const reportedRatio = finite(machine.ratio)
  const freeSlots = finite(machine.free_slots) ?? Math.max(0, machine.slots - machine.running)
  return {
    host: machine.host,
    // Why: admission is the console's call — `allowed` is the same flag the dispatch hook
    // already honours. A busy but allowed machine stays choosable; the hub queues the job.
    available: machine.allowed,
    reason: machine.allowed
      ? null
      : translate(
          'conversationFleet.machineUnavailable',
          'This machine is not currently ready for new work.'
        ),
    cores,
    load1,
    ratio: reportedRatio ?? (cores && cores > 0 && load1 !== null ? load1 / cores : null),
    slots: machine.slots,
    running: machine.running,
    freeSlots,
    memUsedBytes: finite(machine.mem_used_bytes),
    memTotalBytes: finite(machine.mem_total_bytes),
    agents: machine.execution_capabilities.map((capability) => ({
      provider: capability.provider,
      available: capability.available,
      detail: capability.available
        ? translate('conversationFleet.agentSignedIn', 'signed in')
        : (capability.reason ?? translate('conversationFleet.agentUnavailable', 'not available'))
    })),
    lastBeat: machine.last_beat
  }
}

/** "38 / 64 GB" — the two numbers a person compares, never a bare byte count. */
export function formatFleetMemory(used: number | null, total: number | null): string | null {
  if (used === null || total === null || total <= 0) {
    return null
  }
  const gb = (bytes: number): string => {
    const value = bytes / 1024 ** 3
    return value >= 100 ? String(Math.round(value)) : value.toFixed(1)
  }
  return translate('conversationFleet.memoryUsed', '{{used}} / {{total}} GB', {
    used: gb(used),
    total: gb(total)
  })
}

/** "12 s ago", "3 min ago", "2 h ago" — or null when the machine never reported one. */
export function formatFleetLastBeat(lastBeat: string | null, now = Date.now()): string | null {
  if (!lastBeat) {
    return null
  }
  const at = Date.parse(lastBeat)
  if (Number.isNaN(at)) {
    return null
  }
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 90) {
    return translate('conversationFleet.beatSeconds', '{{count}} s ago', { count: seconds })
  }
  const minutes = Math.round(seconds / 60)
  return minutes < 90
    ? translate('conversationFleet.beatMinutes', '{{count}} min ago', { count: minutes })
    : translate('conversationFleet.beatHours', '{{count}} h ago', {
        count: Math.round(minutes / 60)
      })
}

/** "load 1.2/10" — shown only when the runner reported both numbers. */
export function formatFleetLoad(health: FleetMachineHealth): string | null {
  return health.load1 !== null && health.cores !== null
    ? translate('conversationFleet.loadOfCores', 'load {{load}}/{{cores}}', {
        load: health.load1.toFixed(1),
        cores: health.cores
      })
    : null
}
