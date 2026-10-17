import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersistentSessionAnswerQuarantine } from './session-answer-quarantine'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'answer-quarantine-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('persistent pending answers', () => {
  it('retains the pending marker across a fresh runtime instance until verified clear', () => {
    const first = new PersistentSessionAnswerQuarantine(directory)
    expect(first.has('workspace:pane')).toBe(false)
    first.add('workspace:pane', { fingerprint: 'checked-prompt', chosen: 'allow' })
    const restarted = new PersistentSessionAnswerQuarantine(directory)
    expect(restarted.has('workspace:pane')).toBe(true)
    expect(() => restarted.add('workspace:pane')).toThrow()
    expect(restarted.has('other:pane')).toBe(false)
    restarted.delete('workspace:pane')
    expect(new PersistentSessionAnswerQuarantine(directory).has('workspace:pane')).toBe(false)
  })

  it('keeps an incomplete marker quarantined instead of assuming an interrupted write never ran', () => {
    const store = new PersistentSessionAnswerQuarantine(directory)
    store.add('pane')
    const path = join(directory, 'session-answer-pending-v1')
    writeFileSync(join(path, readdirSync(path)[0]), '')
    expect(new PersistentSessionAnswerQuarantine(directory).has('pane')).toBe(true)
  })

  it('fails closed when the persistence directory cannot be created', () => {
    const file = join(directory, 'not-a-directory')
    writeFileSync(file, '')
    const store = new PersistentSessionAnswerQuarantine(file)
    expect(() => store.add('pane')).toThrow()
    expect(() => store.has('pane')).toThrow()
  })
})
