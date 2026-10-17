import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWorkNoticeCursor, writeWorkNoticeCursor } from './work-notice-cursor'

describe('Work notice cursor on disk', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'work-notice-'))
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('retains delivered IDs, pending ack and the last acked cursor on a fresh read', () => {
    const path = join(directory, 'profile-one.json')
    const cursor = { after: '10', pending: '12', seen: ['11', '12'] }
    writeWorkNoticeCursor(path, cursor)
    expect(readWorkNoticeCursor(path)).toEqual(cursor)
    writeWorkNoticeCursor(path, { ...cursor, after: '12', pending: null })
    expect(readWorkNoticeCursor(path).after).toBe('12')
    expect(readWorkNoticeCursor(join(directory, 'profile-two.json')).after).toBeNull()
  })

  it('refuses corrupt state instead of silently replaying the inbox', () => {
    const path = join(directory, 'profile.json')
    writeFileSync(path, '{"after":false}')
    expect(() => readWorkNoticeCursor(path)).toThrow()
  })
})
