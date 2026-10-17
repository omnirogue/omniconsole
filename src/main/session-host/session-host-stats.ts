/**
 * What this computer answers to `sessionHost.hostStats`, and what the local Mac shows for itself in
 * the same shape: its own memory reading plus the live conversations its registry observes.
 */

import type { HostMemory } from '../../shared/process-stats-types'
import type { SessionHostStats } from '../../shared/session-host-stats'
import { collectHostMemory } from '../memory/host-memory'
import type { SessionHostService } from './session-host-service'

type StatsService = Pick<SessionHostService, 'identity' | 'observe'>

// Why 60 s: longer than the badges' 30 s poll, so the steady poll reuses every other observe.
const LIVE_COUNT_TTL_MS = 60_000
const liveCounts = new WeakMap<
  object,
  { at: number; count: Promise<number | null> }
>()

async function observeLiveSessions(service: Pick<StatsService, 'observe'>): Promise<number | null> {
  try {
    const observed = await service.observe({})
    return observed.status === 'ok'
      ? observed.sessions.filter((session) => session.verdict === 'live').length
      : null
  } catch {
    return null
  }
}

/**
 * Null when the registry could not be observed: never read as zero sessions. The executor has no
 * cheaper liveness source, so one observe is shared across callers within a short TTL and
 * concurrent reads join the same call.
 */
export function countLiveSessions(
  service: Pick<StatsService, 'observe'>,
  now: () => number = Date.now
): Promise<number | null> {
  const cached = liveCounts.get(service)
  if (cached && now() - cached.at < LIVE_COUNT_TTL_MS) {
    return cached.count
  }
  const count = observeLiveSessions(service)
  liveCounts.set(service, { at: now(), count })
  void count.then((value) => {
    if (value === null && liveCounts.get(service)?.count === count) {
      liveCounts.delete(service)
    }
  })
  return count
}

export function hostStatsMemory(memory: HostMemory): SessionHostStats['memory'] {
  return {
    totalMemory: memory.totalMemory,
    availableMemory: memory.availableMemory,
    cpuCoreCount: memory.cpuCoreCount,
    loadAverage1m: memory.loadAverage1m
  }
}

export async function readSessionHostStats(
  service: StatsService,
  deps: { collect?: () => Promise<HostMemory>; now?: () => number } = {}
): Promise<{ status: 'ok' } & SessionHostStats> {
  const [memory, liveSessions] = await Promise.all([
    (deps.collect ?? collectHostMemory)(),
    countLiveSessions(service, deps.now)
  ])
  return {
    status: 'ok',
    host: service.identity,
    observedAt: (deps.now ?? Date.now)(),
    memory: hostStatsMemory(memory),
    liveSessions
  }
}
