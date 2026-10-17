/**
 * What R2/R3 already did with one target's facts, so a tick neither repeats a would-line nor acts
 * twice. Keyed by the gate as well: a would-line written in shadow never stands in for the act once
 * the mode turns on (or the restore flood guard does). A keep holds only for a retry window, since
 * what kept the target (main unreadable, processes unreadable, a command running) can pass while
 * its facts stay the same.
 */

/** How long a recheck keep stands before the same facts are re-checked. */
export const IDLE_AUTO_CLOSE_KEEP_RETRY_MS = 5 * 60 * 1000

type SettledEntry = { signature: string; gate: string; until: number }

const settledById = new Map<string, SettledEntry>()

export function idleGateKey(gate: { mode: string; act: boolean }): string {
  return `${gate.mode}|${gate.act}`
}

export function isIdleTargetSettled(
  id: string,
  signature: string,
  gateKey: string,
  now: number
): boolean {
  const entry = settledById.get(id)
  return (
    entry !== undefined &&
    entry.signature === signature &&
    entry.gate === gateKey &&
    now < entry.until
  )
}

/** `final`: logged, acted or failed for these facts under this gate. `kept`: retry later. */
export function settleIdleTarget(
  id: string,
  signature: string,
  gateKey: string,
  now: number,
  how: 'final' | 'kept'
): void {
  settledById.set(id, {
    signature,
    gate: gateKey,
    until: how === 'final' ? Number.POSITIVE_INFINITY : now + IDLE_AUTO_CLOSE_KEEP_RETRY_MS
  })
}

/** Forgets targets no rule proposed this tick. */
export function pruneSettledIdleTargets(liveIds: { has(id: string): boolean }): void {
  for (const id of settledById.keys()) {
    if (!liveIds.has(id)) {
      settledById.delete(id)
    }
  }
}

export function clearSettledIdleTargets(): void {
  settledById.clear()
}
