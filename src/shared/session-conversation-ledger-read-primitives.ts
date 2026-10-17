/**
 * The primitive reads behind the conversation-ledger readers: each hands back the value only when
 * it has exactly the expected shape and bound, else the reading that asserts least (null, 0, the
 * caller's fallback). Kept apart so the readers module stays within max-lines.
 */

/** A closed vocabulary: a known string passes, anything else becomes the fallback. */
export function oneOf<T extends string>(known: readonly T[], fallback: T): (value: unknown) => T {
  const set = new Set<string>(known)
  return (value) => (typeof value === 'string' && set.has(value) ? (value as T) : fallback)
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function boundedText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

/** A non-negative safe integer, else 0 (unknown). */
export function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
