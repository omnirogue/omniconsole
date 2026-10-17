import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWriteLatch, isWriteLatchOpen } from './terminal-write-latch'

const directories: string[] = []
const closes: (() => void)[] = []
const binding = {
  daemonNonce: 'daemon-1',
  sessionId: 'session-1',
  receiver: { pid: 4242, pgid: 4242, startTimeMs: 1000 }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'omni-write-latch-'))
  directories.push(dir)
  const tokenPath = join(dir, 'daemon.token')
  const latch = createWriteLatch(tokenPath, binding)
  closes.push(latch.close)
  const path = join(dir, 'terminal-write-latches', latch.token)
  return { tokenPath, latch, path }
}

afterEach(() => {
  for (const close of closes.splice(0)) {
    close()
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('terminal owner write latches', () => {
  it('opens only for its exact daemon, session and process, and closes synchronously', () => {
    const { tokenPath, latch } = fixture()
    expect(isWriteLatchOpen(tokenPath, latch.token, binding)).toBe(true)
    expect(
      isWriteLatchOpen(tokenPath, latch.token, { ...binding, daemonNonce: 'replacement' })
    ).toBe(false)
    expect(isWriteLatchOpen(tokenPath, latch.token, { ...binding, sessionId: 'replacement' })).toBe(
      false
    )
    expect(
      isWriteLatchOpen(tokenPath, latch.token, {
        ...binding,
        receiver: { ...binding.receiver, startTimeMs: 2000 }
      })
    ).toBe(false)
    latch.close()
    expect(isWriteLatchOpen(tokenPath, latch.token, binding)).toBe(false)
  })

  it('refuses a crashed/reused owner and a truncated or malformed record', () => {
    const { tokenPath, latch, path } = fixture()
    const record = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...record, ownerBirth: 'different incarnation' }))
    expect(isWriteLatchOpen(tokenPath, latch.token, binding)).toBe(false)
    writeFileSync(path, '')
    expect(isWriteLatchOpen(tokenPath, latch.token, binding)).toBe(false)
    writeFileSync(path, '{')
    expect(isWriteLatchOpen(tokenPath, latch.token, binding)).toBe(false)
    expect(isWriteLatchOpen(tokenPath, '../daemon.token', binding)).toBe(false)
  })
})
