import { describe, expect, it } from 'vitest'
import {
  createSessionPrepBatchId,
  isSessionPrepSignInFailure,
  sessionPrepWorktreeName,
  shortSessionPrepReason
} from './session-prep-ids'

describe('sessionPrepWorktreeName', () => {
  it('gives two items with the same title different names', () => {
    const batchId = createSessionPrepBatchId(1_700_000_000_000)
    const first = sessionPrepWorktreeName('Login fix', batchId, 0)
    const second = sessionPrepWorktreeName('Login fix', batchId, 1)
    expect(first).not.toBe(second)
    expect(first).toMatch(/^rp-login-fix-[0-9a-z]{4}-1$/)
    expect(second).toMatch(/^rp-login-fix-[0-9a-z]{4}-2$/)
  })

  it('tells batches apart by their random suffix', () => {
    expect(sessionPrepWorktreeName('Docs', 'sp_abcd1234', 0)).toBe('rp-docs-1234-1')
    expect(sessionPrepWorktreeName('Docs', 'sp_abcd9876', 0)).toBe('rp-docs-9876-1')
  })

  it('falls back to "item" for a title with no usable characters', () => {
    expect(sessionPrepWorktreeName('→ …', 'sp_abcd1234', 2)).toBe('rp-item-1234-3')
  })
})

describe('shortSessionPrepReason', () => {
  it('keeps the line that says what failed, not the warnings before it', () => {
    const warning =
      'Permission allow rule (x): Bash(python3 * a.py *) has a wildcard before the rest. '
    const message = `Claude CLI command failed with code 1: ${warning.repeat(3)}Failed to authenticate: OAuth session expired and could not be refreshed`
    expect(shortSessionPrepReason(new Error(message))).toBe(
      'Failed to authenticate: OAuth session expired and could not be refreshed'
    )
    expect(isSessionPrepSignInFailure(shortSessionPrepReason(new Error(message)))).toBe(true)
  })

  it('keeps short reasons whole and both ends of long unknown ones', () => {
    expect(shortSessionPrepReason(new Error('timed out'))).toBe('timed out')
    const long = `start ${'x'.repeat(300)} end`
    const short = shortSessionPrepReason(long)
    expect(short.startsWith('start')).toBe(true)
    expect(short.endsWith('end')).toBe(true)
    expect(isSessionPrepSignInFailure(short)).toBe(false)
  })
})
