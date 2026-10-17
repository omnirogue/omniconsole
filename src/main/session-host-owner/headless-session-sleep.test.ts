import { describe, expect, it, vi } from 'vitest'
import { createHeadlessSessionSleep, type HeadlessSleepSnapshot } from './headless-session-sleep'
import { sidebarRow } from '../session-manage/session-manage-test-fixtures'

const TODAY = Date.parse('2026-10-02T18:00:00Z')
const IDLE = 30 * 60_000
function fixture(review?: { idleMs: number; launchOptions?: { model?: string; effort?: string } }) {
  let now = TODAY
  let enabled = true
  let authority = 'owner:1:turn:1'
  const settings = {
    idleAutoCloseMode: 'on' as 'on' | 'off' | 'shadow',
    idleAutoCloseMinutes: 30,
    restoreFloodGuard: true,
    automaticSessionCleanupProtection: {
      protectedWorkspacePaths: ['/Work/Email Operations'],
      protectedPaneKeys: [],
      protectStartedToday: true,
      timeZone: 'America/New_York'
    }
  }
  const row = sidebarRow({
    hostId: 'local',
    worktreePath: '/Work/task',
    pinned: false,
    saved: false
  })
  const snapshot: HeadlessSleepSnapshot = {
    row,
    ptyId: 'pty-a',
    incarnationId: 'inc-a',
    terminalHandle: 'handle-a',
    leafId: 'leaf-1',
    createdAt: TODAY - 86_400_000,
    lastActivityAt: TODAY - IDLE,
    routine: false,
    record: {
      paneKey: row.paneKey!,
      tabId: row.tabId!,
      worktreeId: row.worktreeId,
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'provider-a' },
      prompt: '',
      state: 'done',
      capturedAt: TODAY,
      updatedAt: TODAY
    }
  }
  const proof = {
    ptyId: 'pty-a',
    incarnationId: 'inc-a',
    rootPid: 20,
    pid: 21,
    pgid: 20,
    startTimeMs: TODAY - 86_400_000,
    agent: 'codex',
    via: 'hook-report' as const
  }
  const read = vi.fn(async () => snapshot)
  const clear = vi.fn(async () => proof)
  const sleep = vi.fn(async (_snapshot, guard) => guard())
  const audit = vi.fn(async () => {})
  const pass = createHeadlessSessionSleep({
    enabled: () => enabled,
    settings: () => settings,
    authority: () => authority,
    read,
    clear,
    sleep,
    audit,
    now: () => now,
    ...(review
      ? {
          reviewTargets: () =>
            new Map([
              [row.paneKey!, { worktreeId: row.worktreeId, paneKey: row.paneKey!, ...review }]
            ])
        }
      : {})
  })
  return {
    pass: () => pass([row]),
    advance: () => {
      now += IDLE
    },
    disable: () => {
      enabled = false
    },
    replaceAuthority: () => {
      authority = 'owner:2:turn:2'
    },
    settings,
    snapshot,
    proof,
    read,
    clear,
    sleep,
    audit
  }
}

describe('headless owner idle sleep', () => {
  it('requires a continuous idle window and rechecks the same process before sleep', async () => {
    const f = fixture()
    await f.pass()
    expect(f.sleep).not.toHaveBeenCalled()
    f.advance()
    await f.pass()
    expect(f.sleep).toHaveBeenCalledOnce()
    expect(f.audit).toHaveBeenLastCalledWith(f.snapshot, 'done')
  })

  it.each(['routine', 'pinned', 'saved', 'today', 'workspace', 'unknown-routine'])(
    'keeps %s work',
    async (reason) => {
      const f = fixture()
      if (reason === 'routine') {
        f.snapshot.routine = true
      }
      if (reason === 'unknown-routine') {
        f.snapshot.routine = null
      }
      if (reason === 'pinned') {
        f.snapshot.row.pinned = true
      }
      if (reason === 'saved') {
        f.snapshot.row.saved = true
      }
      if (reason === 'today') {
        f.snapshot.createdAt = TODAY
      }
      if (reason === 'workspace') {
        f.snapshot.row.worktreePath = '/Work/Email Operations/child'
      }
      await f.pass()
      f.advance()
      await f.pass()
      expect(f.sleep).not.toHaveBeenCalled()
    }
  )

  it('sleeps a session waiting on its review after the review wait, started today too', async () => {
    const f = fixture({ idleMs: 2 * IDLE, launchOptions: { model: 'gpt-5.5', effort: 'high' } })
    f.snapshot.createdAt = TODAY
    f.snapshot.record.launchConfig = { agentArgs: '--no-daemon', agentEnv: {} }
    await f.pass()
    f.advance()
    await f.pass()
    expect(f.sleep).not.toHaveBeenCalled()
    f.advance()
    await f.pass()
    expect(f.sleep).toHaveBeenCalledOnce()
    expect(f.clear).toHaveBeenLastCalledWith(f.snapshot.row, { reviewWait: true })
    expect(vi.mocked(f.sleep).mock.calls[0]![0].record.launchConfig).toEqual({
      agentArgs: '--no-daemon --model gpt-5.5 -c model_reasoning_effort=high',
      agentEnv: {}
    })
  })

  it('still keeps a pinned session waiting on its review', async () => {
    const f = fixture({ idleMs: IDLE })
    f.snapshot.row.pinned = true
    await f.pass()
    f.advance()
    await f.pass()
    expect(f.sleep).not.toHaveBeenCalled()
  })

  it('does not sleep when a desktop attaches during the final reading', async () => {
    const f = fixture()
    await f.pass()
    f.advance()
    f.clear.mockImplementation(async () => {
      f.disable()
      return f.proof
    })
    await f.pass()
    expect(f.sleep).not.toHaveBeenCalled()
  })

  it('revokes cleanup when the policy changes during the final reading', async () => {
    const f = fixture()
    await f.pass()
    f.advance()
    f.clear.mockImplementation(async () => {
      f.settings.idleAutoCloseMode = 'off'
      return f.proof
    })
    await f.pass()
    expect(f.sleep).not.toHaveBeenCalled()
  })

  it('keeps a replacement process even when its pane still reads done', async () => {
    const f = fixture()
    await f.pass()
    f.advance()
    let read = 0
    f.clear.mockImplementation(async () => ({ ...f.proof, pid: ++read > 1 ? 99 : f.proof.pid }))
    await f.pass()
    expect(f.sleep).not.toHaveBeenCalled()
  })

  it('revokes cleanup when ownership changes while process proof is read', async () => {
    const f = fixture()
    await f.pass()
    f.advance()
    f.clear.mockImplementation(async () => {
      f.replaceAuthority()
      return f.proof
    })
    await f.pass()
    expect(f.sleep).not.toHaveBeenCalled()
  })

  it('revokes cleanup when new input arrives during the final process reading', async () => {
    const f = fixture()
    await f.pass()
    f.advance()
    let checks = 0
    f.clear.mockImplementation(async () => {
      if (++checks > 1) {
        f.snapshot.lastActivityAt += 1
      }
      return f.proof
    })
    await f.pass()
    expect(f.sleep).not.toHaveBeenCalled()
  })

  it('logs shadow once without stopping or checkpointing', async () => {
    const f = fixture()
    f.settings.idleAutoCloseMode = 'shadow'
    await f.pass()
    f.advance()
    await f.pass()
    await f.pass()
    expect(f.sleep).not.toHaveBeenCalled()
    expect(f.audit).toHaveBeenCalledExactlyOnceWith(f.snapshot, 'would')
  })

  it('labels an unverified exit as failed, never done', async () => {
    const f = fixture()
    f.sleep.mockResolvedValue(false)
    await f.pass()
    f.advance()
    await f.pass()
    expect(f.audit).toHaveBeenLastCalledWith(f.snapshot, 'failed')
  })
})
