/* #843: main must not materialise a daemon session whose process is gone as a live terminal. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

const GONE_PID = 424_244
const LIVE_PID = 424_245

describe('daemon inventory ignores sessions whose process is gone (#843)', () => {
  let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>>
  let adapter: DaemonPtyAdapter
  const pids = [GONE_PID, LIVE_PID]

  beforeEach(async () => {
    let spawned = 0
    // Why no probe on the server: it plays a daemon that lost the exit callback and still
    // reports the dead session as alive, which is exactly what main has to survive.
    harness = await startDaemonAdapterHarness(() => ({
      ...createMockSubprocess(),
      pid: pids[spawned++ % pids.length]
    }))
    adapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      isPtyProcessGone: (pid) => pid === GONE_PID
    })
  })

  afterEach(async () => {
    adapter.dispose()
    harness.adapter.dispose()
    await harness.server.shutdown().catch(() => {})
  })

  it('drops the dead-pid session from listProcesses, listSessions and hasPty', async () => {
    const { id: goneId } = await adapter.spawn({ cols: 80, rows: 24 })
    const { id: liveId } = await adapter.spawn({ cols: 80, rows: 24 })

    // Control: an adapter without the probe trusts the daemon's isAlive and lists both.
    expect((await harness.adapter.listProcesses()).map((p) => p.id).sort()).toEqual(
      [goneId, liveId].sort()
    )

    const processes = await adapter.listProcesses()

    expect(processes.map((p) => p.id)).toEqual([liveId])
    expect(processes[0]?.rootProcessId).toBe(LIVE_PID)
    expect((await adapter.listSessions()).map((s) => s.sessionId)).toEqual([liveId])
    expect(adapter.hasPty(goneId)).toBe(false)
    expect(adapter.hasPty(liveId)).toBe(true)
  })
})
