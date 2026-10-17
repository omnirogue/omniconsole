import { describe, expect, it, vi } from 'vitest'
import {
  defaultSidebarSessionSurface,
  normalizeSidebarSessionSurface
} from './sidebar-session-surface'

vi.mock('./e2e-config', () => ({ e2eConfig: { enabled: false } }))

describe('routine surface persistence', () => {
  it('defaults to Conversations outside e2e', () => {
    expect(defaultSidebarSessionSurface()).toBe('sessions')
  })
  it.each(['sessions', 'technical', 'goals', 'workspaces'])('preserves %s', (surface) => {
    expect(normalizeSidebarSessionSurface(surface)).toBe(surface)
  })
  // Why: a saved Routines tab reopens on Conversations, where the routines are listed now.
  it.each([null, undefined, 'future', 42, 'routines'])('falls back for %s', (surface) => {
    expect(normalizeSidebarSessionSurface(surface)).toBe('sessions')
  })
})
