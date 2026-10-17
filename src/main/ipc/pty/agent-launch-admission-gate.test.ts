import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentLaunchAdmission,
  type AgentLaunchAdmission
} from '../../pty/agent-launch-admission'
import {
  AGENT_LAUNCH_CANCELLED_ERROR,
  cancelPtySpawnAgentLaunch,
  gatePtySpawnAgentLaunch,
  isLivePtyReattach,
  isPtySpawnAgentLaunch,
  promotePtySpawnAgentLaunch,
  resetAgentLaunchCancellationsForTests,
  resolveAgentLaunchLimit
} from './agent-launch-admission-gate'

function recordingAdmission(admitted = true) {
  const admit = vi.fn<AgentLaunchAdmission['admit']>(async () => admitted)
  const promote = vi.fn<AgentLaunchAdmission['promote']>(() => true)
  return {
    admission: {
      admit,
      promote,
      recheck: () => {},
      isPending: () => false,
      snapshot: () => ({ queued: 0, admittedInWindow: 0 })
    },
    admit,
    promote
  }
}

const settings = () => ({ launchAdmissionPer10s: 3 })

describe('pty spawn agent launch gate', () => {
  it('lets a spawn with no command or a plain shell command bypass admission', async () => {
    const { admission, admit } = recordingAdmission()
    await gatePtySpawnAgentLaunch({
      launchCommand: undefined,
      liveReattach: false,
      getSettings: settings,
      admission
    })
    await gatePtySpawnAgentLaunch({
      launchCommand: 'npm run dev',
      liveReattach: false,
      getSettings: settings,
      admission
    })
    await gatePtySpawnAgentLaunch({
      launchCommand: '   ',
      launchAgent: 'codex',
      liveReattach: false,
      getSettings: settings,
      admission
    })
    expect(admit).not.toHaveBeenCalled()
  })

  it('queues agent starts declared by metadata or recognized from the command', async () => {
    const { admission, admit } = recordingAdmission()
    await gatePtySpawnAgentLaunch({
      launchCommand: 'CODEX_HOME=/x codex resume thread-1',
      launchAgent: 'codex',
      liveReattach: false,
      getSettings: settings,
      admission
    })
    await gatePtySpawnAgentLaunch({
      launchCommand: 'wrapper --go',
      resumeProviderSession: { key: 'session_id', id: 's-1' },
      liveReattach: false,
      getSettings: settings,
      admission
    })
    await gatePtySpawnAgentLaunch({
      launchCommand: 'claude --resume s-2',
      liveReattach: false,
      getSettings: settings,
      admission
    })
    expect(admit).toHaveBeenCalledTimes(3)
    expect(admit.mock.calls.every(([request]) => request.priority === 'background')).toBe(true)
    expect(admit.mock.calls[0][0].getLimit()).toBe(3)
  })

  it('never gates a reattach of a still-running PTY even when it carries a command', async () => {
    const { admission, admit } = recordingAdmission()
    const provider = { hasPty: (id: string) => id === 'live-session' }
    await gatePtySpawnAgentLaunch({
      launchCommand: 'claude --resume s-1',
      launchAgent: 'claude',
      liveReattach: isLivePtyReattach(provider, false, 'live-session'),
      getSettings: settings,
      admission
    })
    expect(admit).not.toHaveBeenCalled()
    expect(isLivePtyReattach(provider, false, 'dead-session')).toBe(false)
    expect(isLivePtyReattach(provider, true, 'live-session')).toBe(false)
    expect(isLivePtyReattach({}, false, 'live-session')).toBe(false)
    expect(
      isLivePtyReattach(
        {
          hasPty: () => {
            throw new Error('boom')
          }
        },
        false,
        'x'
      )
    ).toBe(false)
  })

  it('maps launchPriority person and explicit to their lanes and anything else to background', async () => {
    const { admission, admit } = recordingAdmission()
    for (const launchPriority of ['person', 'explicit', 'urgent', undefined]) {
      await gatePtySpawnAgentLaunch({
        launchCommand: 'codex',
        launchAgent: 'codex',
        launchPriority,
        liveReattach: false,
        getSettings: settings,
        admission
      })
    }
    expect(admit.mock.calls.map(([request]) => request.priority)).toEqual([
      'person',
      'explicit',
      'background',
      'background'
    ])
  })

  it('passes a bounded pane key so a reveal can promote the queued start', async () => {
    const { admission, admit, promote } = recordingAdmission()
    await gatePtySpawnAgentLaunch({
      launchCommand: 'codex resume t-1',
      launchAgent: 'codex',
      launchAdmissionKey: 'tab-1:leaf-1',
      liveReattach: false,
      getSettings: settings,
      admission
    })
    await gatePtySpawnAgentLaunch({
      launchCommand: 'codex resume t-2',
      launchAgent: 'codex',
      launchAdmissionKey: 'x'.repeat(600),
      liveReattach: false,
      getSettings: settings,
      admission
    })
    expect(admit.mock.calls[0][0].key).toBe('tab-1:leaf-1')
    expect(admit.mock.calls[1][0].key).toBeUndefined()

    expect(promotePtySpawnAgentLaunch('tab-1:leaf-1', admission)).toBe(true)
    expect(promote).toHaveBeenCalledWith('tab-1:leaf-1')
    expect(promotePtySpawnAgentLaunch(42, admission)).toBe(false)
    expect(promotePtySpawnAgentLaunch('', admission)).toBe(false)
    expect(promote).toHaveBeenCalledTimes(1)
  })

  it('throws when a queued start is cancelled and skips harnesses without a settings source', async () => {
    const cancelled = recordingAdmission(false)
    await expect(
      gatePtySpawnAgentLaunch({
        launchCommand: 'codex',
        launchAgent: 'codex',
        liveReattach: false,
        getSettings: settings,
        admission: cancelled.admission
      })
    ).rejects.toThrow(AGENT_LAUNCH_CANCELLED_ERROR)

    const unconfigured = recordingAdmission()
    await gatePtySpawnAgentLaunch({
      launchCommand: 'codex',
      launchAgent: 'codex',
      liveReattach: false,
      admission: unconfigured.admission
    })
    expect(unconfigured.admit).not.toHaveBeenCalled()
    expect(
      isPtySpawnAgentLaunch({ launchCommand: 'codex', launchAgent: 'codex', liveReattach: true })
    ).toBe(false)
  })
})

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
}

describe('cancelling a queued agent start', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    resetAgentLaunchCancellationsForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues 5 starts, the 5th pane is disposed while it waits: it never spawns and uses no slot', async () => {
    const admission = createAgentLaunchAdmission()
    const spawned: string[] = []
    const rejected: string[] = []
    const start = (id: string): void => {
      void gatePtySpawnAgentLaunch({
        launchCommand: `codex resume ${id}`,
        launchAgent: 'codex',
        launchAdmissionKey: `tab-${id}:leaf`,
        launchAdmissionToken: `token-${id}`,
        liveReattach: false,
        getSettings: settings,
        admission
      }).then(
        () => spawned.push(id),
        (error: Error) => rejected.push(`${id}:${error.message}`)
      )
    }
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      start(id)
    }
    await settle()
    expect(spawned).toEqual(['a', 'b', 'c'])

    // The transport of pane e is destroyed (tab closed) while e waits.
    expect(cancelPtySpawnAgentLaunch('token-e', admission)).toBe(true)
    await settle()
    expect(rejected).toEqual([`e:${AGENT_LAUNCH_CANCELLED_ERROR}`])
    expect(admission.snapshot().queued).toBe(1)

    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(spawned).toEqual(['a', 'b', 'c', 'd'])
    // e took no slot in this window: d, f and g fill it.
    start('f')
    start('g')
    await settle()
    expect(spawned).toEqual(['a', 'b', 'c', 'd', 'f', 'g'])
    expect(rejected).toHaveLength(1)
  })

  it('starts all 20 CLI/orchestration workers queued behind a restore backlog, keeping each RPC alive', async () => {
    const admission = createAgentLaunchAdmission()
    const started: string[] = []
    const keptAlive: string[] = []
    // 30 mid-task agents auto-continue after a restart (background lane).
    for (let index = 0; index < 30; index += 1) {
      void gatePtySpawnAgentLaunch({
        launchCommand: `codex resume bg-${index}`,
        launchAgent: 'codex',
        interruptedRestore: true,
        liveReattach: false,
        getSettings: settings,
        admission
      }).then(() => started.push(`bg-${index}`))
    }
    // terminal.create and orchestration.workerStart carry no abort signal on the local socket:
    // only the queued hook, which arms the socket keepalive the CLI's timers read as activity.
    for (let index = 0; index < 20; index += 1) {
      void gatePtySpawnAgentLaunch({
        launchCommand: 'codex',
        launchAgent: 'codex',
        launchPriority: 'explicit',
        liveReattach: false,
        getSettings: settings,
        onQueued: () => keptAlive.push(`worker-${index}`),
        admission
      }).then(() => started.push(`worker-${index}`))
    }
    await settle()
    expect(keptAlive).toHaveLength(20)
    // 70 s later: well past the 30 s server idle timer and the CLI's 60 s default.
    await vi.advanceTimersByTimeAsync(70_000)
    await settle()
    const workers = started.filter((id) => id.startsWith('worker-'))
    expect(workers).toEqual(Array.from({ length: 20 }, (_, index) => `worker-${index}`))
    // The workers went ahead of the restore backlog; only the first burst of it ran first.
    expect(started.filter((id) => id.startsWith('bg-'))).toEqual(['bg-0', 'bg-1', 'bg-2', 'bg-3'])
  })

  it("drops a queued start the moment its caller's connection closes, not at the next drain", async () => {
    const admission = createAgentLaunchAdmission()
    for (let index = 0; index < 3; index += 1) {
      void gatePtySpawnAgentLaunch({
        launchCommand: `codex resume t-${index}`,
        launchAgent: 'codex',
        liveReattach: false,
        getSettings: settings,
        admission
      })
    }
    const connection = new AbortController()
    const queued = gatePtySpawnAgentLaunch({
      launchCommand: 'codex',
      launchAgent: 'codex',
      launchPriority: 'person',
      liveReattach: false,
      getSettings: settings,
      isCancelled: () => connection.signal.aborted,
      signal: connection.signal,
      admission
    })
    await settle()
    expect(admission.snapshot().queued).toBe(1)
    connection.abort()
    await expect(queued).rejects.toThrow(AGENT_LAUNCH_CANCELLED_ERROR)
    expect(admission.snapshot().queued).toBe(0)
  })

  it('restoreFloodGuard off is the kill switch for the admission window too', async () => {
    expect(resolveAgentLaunchLimit({ launchAdmissionPer10s: 3, restoreFloodGuard: false })).toBe(0)
    expect(resolveAgentLaunchLimit({ launchAdmissionPer10s: 3 })).toBe(3)
    const admission = createAgentLaunchAdmission()
    let current: { launchAdmissionPer10s: number; restoreFloodGuard?: boolean } = {
      launchAdmissionPer10s: 3
    }
    const started: string[] = []
    const start = (id: string): void => {
      void gatePtySpawnAgentLaunch({
        launchCommand: `codex resume ${id}`,
        launchAgent: 'codex',
        liveReattach: false,
        getSettings: () => current,
        admission
      }).then(() => started.push(id))
    }
    // Guard on: 3 start, 5 wait for later windows.
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      start(id)
    }
    await settle()
    expect(started).toEqual(['a', 'b', 'c'])

    // Sal flips the kill switch: new starts go at once — 12 mid-task agents start together, as
    // before the guard — and every queued start leaves at the next window edge, not 3 of them.
    current = { launchAdmissionPer10s: 3, restoreFloodGuard: false }
    for (let index = 0; index < 12; index += 1) {
      start(`off-${index}`)
    }
    await settle()
    expect(started.filter((id) => id.startsWith('off-'))).toHaveLength(12)
    expect(admission.snapshot().admittedInWindow).toBe(3)
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(started).toEqual(expect.arrayContaining(['d', 'e', 'f', 'g', 'h']))
    expect(admission.snapshot().queued).toBe(0)
  })

  it('cancels a start whose cancel arrived before its spawn reached the gate', async () => {
    const admission = createAgentLaunchAdmission()
    expect(cancelPtySpawnAgentLaunch('token-early', admission)).toBe(false)
    await expect(
      gatePtySpawnAgentLaunch({
        launchCommand: 'codex resume t-1',
        launchAgent: 'codex',
        launchAdmissionToken: 'token-early',
        liveReattach: false,
        getSettings: settings,
        admission
      })
    ).rejects.toThrow(AGENT_LAUNCH_CANCELLED_ERROR)
    expect(admission.snapshot()).toEqual({ queued: 0, admittedInWindow: 0 })
    // Another start's token is unaffected.
    await expect(
      gatePtySpawnAgentLaunch({
        launchCommand: 'codex resume t-2',
        launchAgent: 'codex',
        launchAdmissionToken: 'token-other',
        liveReattach: false,
        getSettings: settings,
        admission
      })
    ).resolves.toBeUndefined()
    expect(cancelPtySpawnAgentLaunch(42, admission)).toBe(false)
  })
})
