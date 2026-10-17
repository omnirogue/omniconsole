/** Shared JEV request plumbing: text budgets, read keys and the process-wide request pool. */

/** What JEV reads of one response: scored alone (rubric, screen), or beside another (pairwise). */
export const JEV_RESPONSE_BYTES = 46_000
export const JEV_PAIR_RESPONSE_BYTES = 22_000

/** A string cut to a byte budget on a character boundary, marked when it was cut. */
export function fitJevText(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= maxBytes) {
    return text
  }
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxBytes))
  return `${decoded.replace(/�$/, '')}\n…[cut to fit]`
}

/**
 * Which candidates are the same answer, read in full and never cut: runs of whitespace collapse,
 * so only padding or wrapping is ignored, and a difference anywhere (even past what JEV is shown)
 * keeps two answers apart. `fitJevText` cuts only what an actual request sends.
 */
export function jevReadKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Every JEV request in this process shares this many slots, so paging never multiplies it. */
const GLOBAL_JEV_CONCURRENCY = 6
let globalJevActive = 0
const globalJevWaiters: (() => void)[] = []

async function withGlobalJevSlot<R>(fn: () => Promise<R>): Promise<R> {
  if (globalJevActive < GLOBAL_JEV_CONCURRENCY) {
    globalJevActive++
  } else {
    // Woken only by a direct hand-off below: the slot is already ours, never re-counted.
    await new Promise<void>((resolve) => globalJevWaiters.push(resolve))
  }
  try {
    return await fn()
  } finally {
    // Hand the slot straight to the next waiter (no decrement in between) so a caller that
    // checks the count while a release is in flight can never see room that is about to be
    // claimed twice.
    const next = globalJevWaiters.shift()
    if (next) {
      next()
    } else {
      globalJevActive--
    }
  }
}

/** Runs `work` over every item, never more than the process-wide JEV slot count at once. */
export async function jevPool<T, R>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  return Promise.all(items.map((item, index) => withGlobalJevSlot(() => work(item, index))))
}
