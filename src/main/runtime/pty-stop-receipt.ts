/**
 * Whether a closed terminal's process is known to have ended: its provider saw that very process
 * (by incarnation) exit, or its SSH host confirmed the exit. A made-up exit (a daemon restart),
 * a stop nobody confirmed, a failed kill, a dropped connection, or an exit that names no
 * incarnation never counts; after the wait those read `unconfirmed`.
 */

export type PtyStopOutcome = 'stopped' | 'unconfirmed'

const MAX_REMEMBERED = 512

/** Whether one `onPtyExit` report is its process's own observed exit. */
export function isPhysicalExitReceipt(args: {
  exitIncarnationId: string | undefined
  options:
    | { hostExitConfirmed?: boolean; providerExitObserved?: boolean; synthetic?: boolean }
    | undefined
  stopNeverConfirmed: boolean
}): boolean {
  const { options } = args
  return (
    Boolean(args.exitIncarnationId) &&
    !args.stopNeverConfirmed &&
    options?.synthetic !== true &&
    (options?.hostExitConfirmed === true || options?.providerExitObserved === true)
  )
}

/** Recent observed exits, by PTY and incarnation exactly (bounded; oldest go first). */
export class CertifiedPtyExits {
  private readonly exits = new Set<string>()

  note(ptyId: string, incarnationId: string): void {
    const key = `${ptyId}\0${incarnationId}`
    this.exits.delete(key)
    this.exits.add(key)
    if (this.exits.size > MAX_REMEMBERED) {
      this.exits.delete(this.exits.values().next().value!)
    }
  }

  /** Only the same process: a missing incarnation on either side never matches. */
  has(ptyId: string, incarnationId: string | null): boolean {
    return Boolean(incarnationId) && this.exits.has(`${ptyId}\0${incarnationId}`)
  }
}

/**
 * Resolves `stopped` once a certified exit is known, `unconfirmed` on an exit that was not
 * certified or when `timeoutMs` passes first. An exit already recorded is read at once.
 */
export function awaitPtyStopReceipt(args: {
  certified: () => boolean
  subscribeExit: (listener: () => void) => () => void
  timeoutMs: number
}): Promise<PtyStopOutcome> {
  if (args.certified()) {
    return Promise.resolve('stopped')
  }
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe = (): void => {}
    const settle = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(args.certified() ? 'stopped' : 'unconfirmed')
    }
    const timer = setTimeout(settle, args.timeoutMs)
    unsubscribe = args.subscribeExit(settle)
    if (settled) {
      unsubscribe()
    }
  })
}
