import { describe, expect, it, vi } from 'vitest'
import type { ArtifactWriteRequest } from '../../shared/artifacts'
import {
  artifactSessionOriginOf,
  resolveArtifactSessionOrigin,
  withResolvedArtifactOrigin
} from './artifact-session-origin'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const PANE_A = `tab-a:${LEAF_A}`
const PANE_B = `tab-b:${LEAF_B}`

function runtime(overrides: Partial<Record<'pane' | 'worktree', string | null>> = {}) {
  return {
    getTerminalPaneKey: vi.fn(() => ('pane' in overrides ? overrides.pane : PANE_A) ?? null),
    getTerminalWorktreeIdForPaneKey: vi.fn(
      () => ('worktree' in overrides ? overrides.worktree : 'wt-live') ?? null
    )
  }
}

const request: ArtifactWriteRequest = {
  sourceKey: '/repo/plan.html',
  content: '<h1>Plan</h1>',
  contentType: 'text/html',
  fileName: 'plan.html'
}

describe('resolveArtifactSessionOrigin', () => {
  it('prefers what the IDE resolves for the terminal handle over the reported env', () => {
    const source = runtime()
    expect(
      resolveArtifactSessionOrigin(source, {
        terminalHandle: 'term-1',
        paneKey: PANE_B,
        worktreeId: 'wt-env'
      })
    ).toEqual({ paneKey: PANE_A, worktreeId: 'wt-live' })
    expect(source.getTerminalPaneKey).toHaveBeenCalledWith('term-1')
    expect(source.getTerminalWorktreeIdForPaneKey).toHaveBeenCalledWith(PANE_A)
  })

  it('falls back to the reported pane and workspace when the handle is unknown', () => {
    expect(
      resolveArtifactSessionOrigin(runtime({ pane: null, worktree: null }), {
        terminalHandle: 'gone',
        paneKey: PANE_B,
        worktreeId: 'wt-env'
      })
    ).toEqual({ paneKey: PANE_B, worktreeId: 'wt-env' })
  })

  it('ignores a malformed pane key and survives a throwing runtime', () => {
    const source = {
      getTerminalPaneKey: () => {
        throw new Error('retired handle')
      },
      getTerminalWorktreeIdForPaneKey: () => null
    }
    expect(
      resolveArtifactSessionOrigin(source, {
        terminalHandle: 'term-1',
        paneKey: 'not-a-pane-key',
        worktreeId: 'wt-env'
      })
    ).toEqual({ worktreeId: 'wt-env' })
  })

  it('returns null outside an IDE terminal', () => {
    expect(resolveArtifactSessionOrigin(runtime(), undefined)).toBeNull()
    expect(resolveArtifactSessionOrigin(runtime({ pane: null }), {})).toBeNull()
  })
})

describe('withResolvedArtifactOrigin', () => {
  it('stores the resolved session and never the terminal handle', () => {
    const resolved = withResolvedArtifactOrigin(runtime(), {
      ...request,
      origin: { terminalHandle: 'term-1' }
    })
    expect(resolved.origin).toEqual({ paneKey: PANE_A, worktreeId: 'wt-live' })
    expect(JSON.stringify(resolved)).not.toContain('term-1')
    expect(artifactSessionOriginOf(resolved)).toEqual({ paneKey: PANE_A, worktreeId: 'wt-live' })
  })

  it('leaves a request without an origin unchanged', () => {
    const resolved = withResolvedArtifactOrigin(runtime(), request)
    expect(resolved).toEqual(request)
    expect(artifactSessionOriginOf(resolved)).toBeUndefined()
  })
})
