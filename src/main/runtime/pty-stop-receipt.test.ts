import { afterEach, describe, expect, it, vi } from 'vitest'
import { awaitPtyStopReceipt, CertifiedPtyExits, isPhysicalExitReceipt } from './pty-stop-receipt'

afterEach(() => {
  vi.useRealTimers()
})

type ExitReport = Parameters<typeof isPhysicalExitReceipt>[0]

/** The runtime's wiring in small: `onPtyExit` notes a receipt only for a physical exit. */
function exits(watched: string | null = 'inc-1') {
  const certified = new CertifiedPtyExits()
  const listeners = new Set<() => void>()
  return {
    certified,
    wait: (timeoutMs = 1_000) =>
      awaitPtyStopReceipt({
        certified: () => certified.has('pty-1', watched),
        subscribeExit: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        timeoutMs
      }),
    exit: (report: Partial<ExitReport>) => {
      const full: ExitReport = {
        exitIncarnationId: 'inc-1',
        options: { providerExitObserved: true },
        stopNeverConfirmed: false,
        ...report
      }
      if (isPhysicalExitReceipt(full)) {
        certified.note('pty-1', full.exitIncarnationId!)
      }
      listeners.forEach((listener) => listener())
    }
  }
}

describe('a closed terminal’s stop receipt', () => {
  it('reads stopped on its own process’s observed exit', async () => {
    const provider = exits()
    const waiting = provider.wait()
    provider.exit({})
    await expect(waiting).resolves.toBe('stopped')
    const host = exits()
    const hostWait = host.wait()
    host.exit({ options: { hostExitConfirmed: true } })
    await expect(hostWait).resolves.toBe('stopped')
  })

  it('reads unconfirmed on a daemon restart’s made-up exit during the wait', async () => {
    const restart = exits()
    const waiting = restart.wait()
    // Why: the restart fans out exits before its shutdown, which may still fail.
    restart.exit({ options: { providerExitObserved: true, synthetic: true } })
    await expect(waiting).resolves.toBe('unconfirmed')
  })

  it('reads unconfirmed on an exit nobody observed, or one that names no process', async () => {
    for (const report of [
      { options: {} },
      { options: undefined },
      { stopNeverConfirmed: true },
      { exitIncarnationId: undefined }
    ] as Partial<ExitReport>[]) {
      const f = exits()
      const waiting = f.wait()
      f.exit(report)
      await expect(waiting, JSON.stringify(report)).resolves.toBe('unconfirmed')
    }
  })

  it('reads unconfirmed when no exit arrives, as when the SSH connection is lost', async () => {
    vi.useFakeTimers()
    const lost = exits()
    const waiting = lost.wait(10_000)
    vi.advanceTimersByTime(10_000)
    await expect(waiting).resolves.toBe('unconfirmed')
  })

  it('never lets an earlier process under the same id certify its replacement', async () => {
    const respawned = exits('inc-2')
    // The first process (inc-1) exited for real before the pane was respawned as inc-2.
    respawned.certified.note('pty-1', 'inc-1')
    const waiting = respawned.wait()
    respawned.exit({ options: {} })
    await expect(waiting).resolves.toBe('unconfirmed')
    expect(respawned.certified.has('pty-1', 'inc-2')).toBe(false)
  })

  it('never matches a process watched without an incarnation', async () => {
    const legacy = exits(null)
    legacy.certified.note('pty-1', 'inc-1')
    const waiting = legacy.wait()
    legacy.exit({})
    await expect(waiting).resolves.toBe('unconfirmed')
    expect(new CertifiedPtyExits().has('pty-1', null)).toBe(false)
  })
})
