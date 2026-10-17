import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  canonicalizeAgentTitleFrame,
  canonicalizePersistedSessionTitles,
  isTitleFrameOnlySessionChange
} from './persisted-title-frames'

describe('persisted title frames', () => {
  it('collapses one-state spinner frames only', () => {
    expect(canonicalizeAgentTitleFrame('◑ Claude Code')).toBe('◐ Claude Code')
    expect(canonicalizeAgentTitleFrame('◓ Say hi')).toBe('◐ Say hi')
    expect(canonicalizeAgentTitleFrame('⠐ Claude Code')).toBe('⠋ Claude Code')
  })

  it('leaves distinct-state glyphs and plain titles alone', () => {
    for (const title of [
      '✳ Claude Code',
      '[ . ] Action Required',
      '[ ! ] Action Required',
      'OmniConsole terminal',
      'build ◑ step',
      ''
    ]) {
      expect(canonicalizeAgentTitleFrame(title)).toBe(title)
    }
  })

  it('returns a canonical copy without mutating the live session', () => {
    const session = {
      tabsByWorktree: { w: [{ id: 't', title: '◒ Fix it' }] },
      unifiedTabs: { w: [{ id: 'u', label: '⠙ Fix it' }] },
      sleepingAgentSessionsByPaneKey: { p: { paneKey: 'p', terminalTitle: '◓ Fix it' } }
    } as unknown as WorkspaceSessionState
    const canonical = canonicalizePersistedSessionTitles(session)
    expect(canonical.tabsByWorktree.w[0].title).toBe('◐ Fix it')
    expect(canonical.unifiedTabs?.w[0].label).toBe('⠋ Fix it')
    expect(canonical.sleepingAgentSessionsByPaneKey?.p.terminalTitle).toBe('◐ Fix it')
    expect(session.tabsByWorktree.w[0].title).toBe('◒ Fix it')
    expect(session.sleepingAgentSessionsByPaneKey?.p.terminalTitle).toBe('◓ Fix it')
  })

  it('returns the same object when nothing needs canonicalizing', () => {
    const session = {
      tabsByWorktree: { w: [{ id: 't', title: '✳ Idle' }] }
    } as unknown as WorkspaceSessionState
    expect(canonicalizePersistedSessionTitles(session)).toBe(session)
  })

  it('detects title-frame-only session changes but not meaningful ones', () => {
    const make = (title: string) =>
      ({ tabsByWorktree: { w: [{ id: 't', title }] } }) as unknown as WorkspaceSessionState
    expect(isTitleFrameOnlySessionChange(make('◐ Fix it'), make('◓ Fix it'))).toBe(true)
    expect(isTitleFrameOnlySessionChange(make('⠋ Fix it'), make('⠙ Fix it'))).toBe(true)
    // Why: distinct-state glyphs are not frames, so a status glyph change must still persist.
    expect(isTitleFrameOnlySessionChange(make('✢ Fix it'), make('✳ Fix it'))).toBe(false)
    expect(isTitleFrameOnlySessionChange(make('◐ Fix it'), make('◐ Ship it'))).toBe(false)
  })
})
