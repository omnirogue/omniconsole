import { z } from 'zod'

/**
 * ⏳ Wait is an attention control: a session, a card or a received thread leaves
 * Active and Needs You on this device until the time passes, then comes back on its
 * own. Nothing underneath is stopped, paused or changed. Per device, like the
 * Sessions tree view.
 */
const schema = z.object({
  version: z.literal(1),
  /** ISO time per key; a key not listed is not waiting. */
  until: z.record(z.string(), z.string()),
  /**
   * ✓ on a session: the ISO time it was called finished. It leaves Needs You for as long as
   * its wait is older than that mark; a new ask after it is new attention.
   */
  done: z.record(z.string(), z.string()).default({}),
  /**
   * ↩ Back to me: the ISO time a plan handed the conversation back. Newer than the pane's
   * last state change, the row needs you again with "Back to you"; opening it clears the mark.
   */
  returned: z.record(z.string(), z.string()).default({})
})

export type WaitLater = z.infer<typeof schema>

export const WAIT_LATER_STORAGE_KEY = 'omni.wait-later.v1'

/** The dial: fast, fixed hours. Anything longer is picked as a date and time. */
export const WAIT_HOURS: readonly number[] = [1, 2, 4, 8, 12, 24, 36, 48]

export function emptyWaitLater(): WaitLater {
  return { version: 1, until: {}, done: {}, returned: {} }
}

export function parseWaitLater(value: unknown): WaitLater {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : emptyWaitLater()
}

export function waitLaterKeyForPane(paneKey: string): string {
  return `pane:${paneKey}`
}

export function waitLaterKeyForThread(threadId: string): string {
  return `thread:${threadId}`
}

export function waitLaterKeyForChain(chainId: string): string {
  return `chain:${chainId}`
}

export function waitLaterKeyForCard(taskId: string): string {
  return `card:${taskId}`
}

export function waitLaterKeyForMessage(threadId: string): string {
  return `message:${threadId}`
}

export function waitLaterHours(hours: number, now: Date): Date {
  return new Date(now.getTime() + hours * 60 * 60 * 1000)
}

/** The device-local calendar day of a moment, in `YYYY-MM-DD`. */
export function localCalendarDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** "8:30 AM", or with the day when it is not today. */
export function describeReturn(until: Date, now: Date): string {
  const sameDay = localCalendarDay(until) === localCalendarDay(now)
  return until.toLocaleString(
    undefined,
    sameDay ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' }
  )
}

/** The whole hours until a moment, rounded up, for "Waiting · 12h". */
export function hoursUntil(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / (60 * 60 * 1000)))
}

export function isWaitingUntil(until: string | undefined, now: Date): boolean {
  if (!until) {
    return false
  }
  const parsed = Date.parse(until)
  return Number.isFinite(parsed) && parsed > now.getTime()
}

export function setWaitLater(view: WaitLater, key: string, until: Date | null): WaitLater {
  const next = { ...view.until }
  if (until) {
    next[key] = until.toISOString()
  } else {
    delete next[key]
  }
  return { ...view, until: next }
}

function withMark(
  marks: Readonly<Record<string, string>>,
  key: string,
  at: Date | null
): Record<string, string> {
  const next = { ...marks }
  if (at) {
    next[key] = at.toISOString()
  } else {
    delete next[key]
  }
  return next
}

export function setFinished(view: WaitLater, key: string, at: Date | null): WaitLater {
  return { ...view, done: withMark(view.done, key, at) }
}

/** ↩ Back to me: the plan ended and the conversation is the person's again. */
export function setReturned(view: WaitLater, key: string, at: Date | null): WaitLater {
  return { ...view, returned: withMark(view.returned, key, at) }
}

const FINISHED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Drop every wait that has passed and every finished mark older than a month. */
export function pruneWaitLater(view: WaitLater, now: Date): WaitLater {
  const until = Object.fromEntries(
    Object.entries(view.until).filter(([, value]) => isWaitingUntil(value, now))
  )
  const fresh = (marks: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(marks).filter(([, value]) => {
        const at = Date.parse(value)
        return Number.isFinite(at) && now.getTime() - at < FINISHED_RETENTION_MS
      })
    )
  return { version: 1, until, done: fresh(view.done), returned: fresh(view.returned) }
}

function marksMap(marks: Readonly<Record<string, string>>): ReadonlyMap<string, number> {
  return new Map(
    Object.entries(marks)
      .map(([key, value]) => [key, Date.parse(value)] as const)
      .filter(([, at]) => Number.isFinite(at))
  )
}

/** Finished marks as a map of key → time (ms), for one comparison per pane. */
export function finishedMarks(view: WaitLater): ReadonlyMap<string, number> {
  return marksMap(view.done)
}

/** Returned marks as a map of key → time (ms): the plan gave this conversation back. */
export function returnedMarks(view: WaitLater): ReadonlyMap<string, number> {
  return marksMap(view.returned)
}

/** A returned mark counts while it is at least as new as the pane's last state change. */
export function isReturnedPane(
  marks: ReadonlyMap<string, number>,
  key: string,
  stateChangedAt: number
): boolean {
  const at = marks.get(key)
  return at !== undefined && at >= stateChangedAt
}

/** A pane called finished stays out of Needs You until it asks again after that mark. */
export function isFinishedPane(
  marks: ReadonlyMap<string, number>,
  key: string,
  stateChangedAt: number
): boolean {
  const at = marks.get(key)
  return at !== undefined && stateChangedAt > 0 && stateChangedAt <= at
}

/** Keys currently waiting, for one cheap membership test per render. */
export function waitingKeys(view: WaitLater, now: Date): ReadonlySet<string> {
  return new Set(
    Object.entries(view.until)
      .filter(([, value]) => isWaitingUntil(value, now))
      .map(([key]) => key)
  )
}
