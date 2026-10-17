import { describe, expect, it } from 'vitest'
import { HookProcessIdentity, readAgentPid } from './hook-process-identity'

describe('hook process ownership', () => {
  it('rejects every helper event while the parent lives, regardless of provider/session', () => {
    const identity = new HookProcessIdentity(() => true)
    identity.bind('pane', 100)
    expect(identity.accepts('pane', 200)).toBe(false)
    expect(identity.accepts('pane', 100)).toBe(true)
    expect(identity.accepts('another-pane', 200)).toBe(true)
  })

  it('rebinds after an exited parent', () => {
    const live = new Set([200])
    const identity = new HookProcessIdentity((pid) => live.has(pid))
    identity.bind('pane', 100)
    expect(identity.accepts('pane', 200)).toBe(true)
    identity.bind('pane', 200)
    expect(identity.accepts('pane', 300)).toBe(false)
  })

  it('keeps legacy events compatible without releasing ownership', () => {
    const identity = new HookProcessIdentity(() => true)
    identity.bind('pane', 100)
    expect(identity.accepts('pane', undefined)).toBe(true)
    identity.bind('pane', undefined)
    expect(identity.accepts('pane', 200)).toBe(false)
    identity.clear()
    expect(identity.accepts('pane', 200)).toBe(true)
  })

  it('does not treat malformed or non-positive wire PIDs as processes', () => {
    for (const raw of [0, 1, -1, 1.5, Number.NaN, '1e3', '12oops', {}, null]) {
      expect(readAgentPid(raw)).toBeUndefined()
    }
    expect(readAgentPid('123')).toBe(123)
  })
})

describe('the process a pane’s hooks name', () => {
  it('is the live owner, and nothing once that process exited', () => {
    const live = new Set([100])
    const identity = new HookProcessIdentity((pid) => live.has(pid))
    expect(identity.ownerOf('pane')).toBeUndefined()
    identity.bind('pane', 100)
    expect(identity.ownerOf('pane')).toBe(100)
    live.delete(100)
    expect(identity.ownerOf('pane')).toBeUndefined()
  })
})
