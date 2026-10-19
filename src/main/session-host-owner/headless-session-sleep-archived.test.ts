import { describe, expect, it, vi } from 'vitest'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { sidebarRow } from '../session-manage/session-manage-test-fixtures'
import { createHeadlessSessionSleep } from './headless-session-sleep'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const PROTECTION = {
  protectedWorkspacePaths: ['/work/email'],
  protectedPaneKeys: [],
  protectStartedToday: true,
  timeZone: 'America/New_York'
}

function headless(row: SessionManageSidebarRow, createdAt: number) {
  let now = NOW
  const snapshot = {
    row,
    ptyId: 'pty-a',
    incarnationId: 'inc-a',
    terminalHandle: 'handle-a',
    leafId: 'leaf-1',
    createdAt,
    lastActivityAt: NOW - 3_600_000,
    routine: false,
    record: {
      paneKey: row.paneKey!,
      tabId: row.tabId!,
      worktreeId: row.worktreeId,
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'provider-a' },
      prompt: '',
      state: 'done',
      capturedAt: NOW,
      updatedAt: NOW
    }
  }
  const proof = {
    ptyId: 'pty-a',
    incarnationId: 'inc-a',
    rootPid: 20,
    pid: 21,
    pgid: 20,
    startTimeMs: createdAt,
    agent: 'codex',
    via: 'hook-report' as const
  }
  const clear = vi.fn(async () => proof)
  const sleep = vi.fn(async (_snapshot: unknown, guard: () => Promise<boolean>) => guard())
  const pass = createHeadlessSessionSleep({
    enabled: () => true,
    settings: () =>
      ({
        idleAutoCloseMode: 'on',
        idleAutoCloseMinutes: 30,
        restoreFloodGuard: true,
        automaticSessionCleanupProtection: PROTECTION
      }) as never,
    authority: () => 'owner:1:turn:1',
    read: async () => snapshot as never,
    clear,
    sleep: sleep as never,
    audit: vi.fn(async () => {}),
    now: () => now
  })
  return {
    run: async () => {
      await pass([row])
      now += 31 * 60_000
      await pass([row])
    },
    clear,
    sleep
  }
}

describe('headless sleep of an archived session (#1214 change b)', () => {
  it('lets headless sleep stop an idle archived session started today, and nothing else it keeps', async () => {
    const today = NOW - 60_000
    const base = { hostId: 'local', worktreePath: '/work/task', pinned: false, saved: false }
    const live = headless(sidebarRow(base), today)
    await live.run()
    expect(live.sleep).not.toHaveBeenCalled()
    const archivedRow = sidebarRow({ ...base, archived: true })
    const archived = headless(archivedRow, today)
    await archived.run()
    expect(archived.sleep).toHaveBeenCalledOnce()
    expect(archived.clear).toHaveBeenCalledWith(archivedRow, {
      reviewWait: false,
      rows: [archivedRow]
    })
    for (const keep of [{ pinned: true }, { saved: true }, { worktreePath: '/work/email/x' }]) {
      const kept = headless(sidebarRow({ ...base, archived: true, ...keep }), today)
      await kept.run()
      expect(kept.sleep, JSON.stringify(keep)).not.toHaveBeenCalled()
    }
  })
})
