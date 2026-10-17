import { describe, expect, it } from 'vitest'
import { normalizeSidebarSessionSurface } from './sidebar-session-surface'

describe('normalizeSidebarSessionSurface', () => {
  it('migrates the retired companies value to sessions (Conversations), its human default', () => {
    expect(normalizeSidebarSessionSurface('companies')).toBe('sessions')
  })

  it('passes every current surface value through unchanged', () => {
    expect(normalizeSidebarSessionSurface('sessions')).toBe('sessions')
    expect(normalizeSidebarSessionSurface('technical')).toBe('technical')
    expect(normalizeSidebarSessionSurface('workspaces')).toBe('workspaces')
  })

  it('falls back to sessions for anything else unrecognised — undefined, null, garbage', () => {
    expect(normalizeSidebarSessionSurface(undefined)).toBe('sessions')
    expect(normalizeSidebarSessionSurface(null)).toBe('sessions')
    expect(normalizeSidebarSessionSurface('')).toBe('sessions')
    expect(normalizeSidebarSessionSurface(42)).toBe('sessions')
  })
})
