import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import {
  beginTerminalDraft,
  clearUnresolvedDraft,
  hasUnresolvedDraft,
  markUnresolvedDraft,
  terminalDraftWriteFence
} from './terminal-unresolved-draft'

const storage = vi.hoisted(() => ({ path: '' }))
vi.mock('../omni-profiles/profile-storage-paths', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  storage.path = mkdtempSync(join(tmpdir(), 'omni-draft-persistence-'))
  return { getProfileUserDataPath: () => storage.path }
})

afterEach(() => clearUnresolvedDraft('pty'))
afterAll(() => rmSync(storage.path, { recursive: true, force: true }))

describe('unsent terminal draft persistence', () => {
  it('survives loss of all main memory before any confirmed Enter', async () => {
    beginTerminalDraft('pty')
    vi.resetModules()
    const restored = await import('./terminal-unresolved-draft')
    expect(restored.hasUnresolvedDraft('pty')).toBe(true)
    expect(() => restored.beginTerminalDraft('pty')).toThrow('Unsent text')
  })

  it('revokes an in-flight write synchronously when the person takes over, without clearing the draft', () => {
    const owner = beginTerminalDraft('pty')
    const fence = terminalDraftWriteFence('pty', owner)
    const invalidate = vi.fn()
    fence.onClose!(invalidate)
    markUnresolvedDraft('pty')
    expect(invalidate).toHaveBeenCalledOnce()
    expect(fence.isRevoked()).toBe(true)
    expect(hasUnresolvedDraft('pty')).toBe(true)
    clearUnresolvedDraft('pty')
    expect(hasUnresolvedDraft('pty')).toBe(false)
  })
})
