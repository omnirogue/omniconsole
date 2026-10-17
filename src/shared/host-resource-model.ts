/**
 * One computer's resources as every surface shows them (host headers, the Resource Manager's
 * Computers list, the dispatch warning): free of total memory, load per core with Sal's
 * Offload-Before-Overload band, and live sessions. The local Mac and paired/SSH hosts share it.
 */

export type HostResourceMemory = {
  totalMemory: number
  availableMemory: number
  cpuCoreCount: number
  loadAverage1m: number
}

/**
 * - `checking`: not read yet.
 * - `unavailable`: could not be asked, did not answer, or predates host stats; shown as a dash.
 * - `ok`: the host answered with its own reading.
 */
export type HostResourceState = 'checking' | 'unavailable' | 'ok'

export type HostResourceReading = {
  /** `local`, `ssh:<target>` or `runtime:<environment>`, as host rows carry it. */
  hostKey: string
  state: HostResourceState
  /** Why it is unavailable, in the host's or transport's words. */
  detail?: string
  /** When this Mac received the reading (its own clock, so ages never skew). */
  readAt: number | null
  memory: HostResourceMemory | null
  /** Null when the host could not count them; never shown as zero. */
  liveSessions: number | null
}

export type HostLoadBand = 'ok' | 'offload' | 'hot'

/** Offload-Before-Overload: offload from 0.6 load per core, hot above 0.8. */
export const HOST_LOAD_OFFLOAD_AT = 0.6
export const HOST_LOAD_HOT_ABOVE = 0.8

export function hostLoadBand(loadPerCore: number): HostLoadBand {
  if (loadPerCore > HOST_LOAD_HOT_ABOVE) {
    return 'hot'
  }
  return loadPerCore >= HOST_LOAD_OFFLOAD_AT ? 'offload' : 'ok'
}

export type HostResourceView = {
  freeBytes: number
  totalBytes: number
  freeGb: number
  totalGb: number
  loadAverage1m: number
  cpuCoreCount: number
  loadPerCore: number
  band: HostLoadBand
  liveSessions: number | null
  /** Whole seconds since it was read; null when the reading has no time. */
  ageSeconds: number | null
}

const GIB = 1024 ** 3

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/** Null unless the host answered: an unread host has no numbers, not zeros. */
export function deriveHostResourceView(
  reading: HostResourceReading | null | undefined,
  now: number
): HostResourceView | null {
  if (!reading || reading.state !== 'ok' || !reading.memory) {
    return null
  }
  const totalBytes = finiteNonNegative(reading.memory.totalMemory)
  const freeBytes = Math.min(totalBytes, finiteNonNegative(reading.memory.availableMemory))
  const cpuCoreCount = Math.max(1, Math.round(finiteNonNegative(reading.memory.cpuCoreCount)))
  const loadAverage1m = finiteNonNegative(reading.memory.loadAverage1m)
  const loadPerCore = loadAverage1m / cpuCoreCount
  return {
    freeBytes,
    totalBytes,
    freeGb: freeBytes / GIB,
    totalGb: totalBytes / GIB,
    loadAverage1m,
    cpuCoreCount,
    loadPerCore,
    band: hostLoadBand(loadPerCore),
    liveSessions: reading.liveSessions,
    ageSeconds:
      reading.readAt === null ? null : Math.max(0, Math.round((now - reading.readAt) / 1000))
  }
}

/** "12" for the badge; one decimal under 10 GB so a small host does not read as 0 or 1. */
export function formatBadgeGb(gb: number): string {
  return gb < 10 ? gb.toFixed(1) : String(Math.round(gb))
}

/** "12.4" for the tooltip; whole numbers for large totals ("32", "128"). */
export function formatDetailGb(gb: number): string {
  return Number.isInteger(Math.round(gb * 10) / 10) || gb >= 100
    ? String(Math.round(gb))
    : gb.toFixed(1)
}

/** One decimal for the badge (`0.3/core`); two where a band edge matters (`0.84` is hot). */
export function formatLoadPerCore(loadPerCore: number, digits: 1 | 2 = 1): string {
  return loadPerCore.toFixed(digits)
}

export type HostLoadCandidate = {
  id: string
  label: string
  loadPerCore: number | null
  /** False when it may not be chosen at all (not admitted, not connected). */
  available: boolean
}

/** The `ok`-band host with the lowest load per core other than `excludeId`, or null. */
export function freestOkHost<T extends HostLoadCandidate>(
  candidates: readonly T[],
  excludeId: string
): T | null {
  let best: T | null = null
  for (const candidate of candidates) {
    if (
      candidate.id === excludeId ||
      !candidate.available ||
      candidate.loadPerCore === null ||
      !Number.isFinite(candidate.loadPerCore) ||
      hostLoadBand(candidate.loadPerCore) !== 'ok'
    ) {
      continue
    }
    if (!best || candidate.loadPerCore < (best.loadPerCore ?? Infinity)) {
      best = candidate
    }
  }
  return best
}

export type HostLoadWarning<T extends HostLoadCandidate> = {
  target: T & { loadPerCore: number }
  /** The freest `ok` host to offload to instead; null when none is. */
  suggestion: T | null
}

/** A warning only when the chosen host is `hot`; it never changes or blocks the choice. */
export function hostLoadWarning<T extends HostLoadCandidate>(
  candidates: readonly T[],
  selectedId: string | null
): HostLoadWarning<T> | null {
  const target = selectedId ? candidates.find((candidate) => candidate.id === selectedId) : null
  if (!target || target.loadPerCore === null || hostLoadBand(target.loadPerCore) !== 'hot') {
    return null
  }
  return {
    target: target as T & { loadPerCore: number },
    suggestion: freestOkHost(candidates, target.id)
  }
}
