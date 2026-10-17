export const ORCHESTRATION_SHADOW_LIMITS = {
  entries: 32,
  totalEntries: 512,
  referenceChars: 256
} as const

export type ShadowSample<T> = {
  values: T[]
  total: number
  start: number
  complete: boolean
}

/** One save may inspect only this many source entries, including nested arrays. */
export class OrchestrationShadowScan {
  private remaining: number = ORCHESTRATION_SHADOW_LIMITS.totalEntries
  private readonly samples = new WeakMap<object, ShadowSample<unknown>>()

  tail<T>(
    source: readonly T[] | undefined,
    limit: number = ORCHESTRATION_SHADOW_LIMITS.entries
  ): ShadowSample<T> {
    if (!source) {
      return { values: [], total: 0, start: 0, complete: true }
    }
    const cached = this.samples.get(source)
    if (cached) {
      return cached as ShadowSample<T>
    }
    const total = source.length
    const count = Math.min(total, limit, ORCHESTRATION_SHADOW_LIMITS.entries, this.remaining)
    const start = total - count
    const values: T[] = []
    for (let index = start; index < total; index++) {
      values.push(source[index]!)
    }
    this.remaining -= count
    const sample = { values, total, start, complete: count === total }
    this.samples.set(source, sample)
    recordSample(count, total)
    return sample
  }
}

export function shadowIdentity(value: unknown): value is string {
  if (typeof value === 'string' && value.length > ORCHESTRATION_SHADOW_LIMITS.referenceChars) {
    count('oversizedIdentitySkipped')
  }
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ORCHESTRATION_SHADOW_LIMITS.referenceChars
  )
}

function recordSample(inspected: number, total: number): void {
  count('sourceArraysSampled')
  count('sourceEntriesInspected', inspected)
  count('sourceEntriesOmitted', total - inspected)
  if (inspected < total) {
    count('sourceArraysTruncated')
  }
}

/** Refuse oversized identities rather than hash arbitrary source text on the save path. */
export function shadowReference(...parts: (string | number)[]): string {
  const text = parts.map((part) =>
    typeof part === 'number' && Number.isFinite(part) ? String(part) : part
  )
  return text.every(shadowIdentity) ? text.join(':') : ''
}

export function shadowFieldEqual(left: unknown, right: unknown): boolean {
  if (typeof left === 'string' && left.length > ORCHESTRATION_SHADOW_LIMITS.referenceChars) {
    return false
  }
  if (typeof right === 'string' && right.length > ORCHESTRATION_SHADOW_LIMITS.referenceChars) {
    return false
  }
  return left === right
}
import { countOrchestrationShadow as count } from './orchestration-shadow-measurement'
