import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  removeHandler: vi.fn(),
  userData: ''
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipc.handlers.set(channel, handler)
    },
    removeHandler: ipc.removeHandler
  }
}))
vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => ipc.userData
}))

const { registerBackgroundRuntimeTerminalsHandler } = await import('./background-runtime-terminals')

ipc.userData = mkdtempSync(join(tmpdir(), 'background-terminals-'))
afterAll(() => rmSync(ipc.userData, { recursive: true, force: true }))

const orphan = {
  ptyId: 'pty-orphan',
  worktreeId: 'repo::/ads',
  tabId: 'tab-orphan',
  paneKey: 'tab-orphan:leaf-1',
  handle: 'term_orphan',
  title: 'claude conversation',
  launchAgent: 'claude',
  hostId: 'local'
}
const mainFrame = {}
const ownWindow = { senderFrame: mainFrame, sender: { mainFrame } }

function register(listed: unknown[] | null) {
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    listBackgroundRuntimeOwnedTerminals: vi.fn(() => listed),
    closeTerminal: vi.fn(async (handle: string) => ({
      handle,
      tabId: 'tab-orphan',
      ptyKilled: true
    }))
  }
  registerBackgroundRuntimeTerminalsHandler(runtime as never)
  return {
    runtime,
    list: ipc.handlers.get('runtime:listBackgroundTerminals')!,
    end: ipc.handlers.get('runtime:endBackgroundTerminal')!
  }
}

beforeEach(() => {
  ipc.handlers.clear()
})

describe('background terminal requests from the owner sidebar', () => {
  it('answers its own window from the runtime and refuses a stale frame', () => {
    const { runtime, list } = register([orphan])

    expect(list(ownWindow)).toEqual([orphan])
    expect(() => list({ senderFrame: {}, sender: { mainFrame } })).toThrow('main frame')
    expect(runtime.listBackgroundRuntimeOwnedTerminals).toHaveBeenCalledOnce()
  })

  it('ends a person-named one through the audited close and records who ended it', async () => {
    const { runtime, end } = register([orphan])

    await expect(end(ownWindow, { ptyId: 'pty-orphan' })).resolves.toEqual({
      ended: true,
      ptyKilled: true
    })

    expect(runtime.closeTerminal).toHaveBeenCalledExactlyOnceWith('term_orphan')
    const lines = readFileSync(join(ipc.userData, 'session-actions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines.at(-1)).toMatchObject({
      actor: 'person',
      action: 'session.delete',
      target: { paneKey: 'tab-orphan:leaf-1', tabId: 'tab-orphan', title: 'claude conversation' },
      reason: 'Ended from the Conversations sidebar.',
      after: { ptyId: 'pty-orphan', ptyKilled: true, background: true }
    })
  })

  it('re-checks first and ends nothing that is no longer a background process', async () => {
    const { runtime, end } = register([])

    await expect(end(ownWindow, { ptyId: 'pty-orphan' })).rejects.toThrow(
      'no longer runs in the background'
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })
})
