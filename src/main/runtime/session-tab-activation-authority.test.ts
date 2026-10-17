import { describe, expect, it } from 'vitest'
import {
  assertSessionTabActivationAllowed,
  classifyMissingSessionTab,
  classifySessionTabActivation,
  type SessionTabActivationEvidence
} from './session-tab-activation-authority'
import { isRetryableSessionTabActivationRefusal } from '../../shared/session-tab-activation-refusal'

function evidence(overrides: Partial<SessionTabActivationEvidence>): SessionTabActivationEvidence {
  return {
    publication: { kind: 'window', listed: true },
    liveRuntimeOwned: false,
    liveGraphLeaf: false,
    mountedGraphLeaf: false,
    runtimeOwnedBinding: false,
    surfaceReady: false,
    ...overrides
  }
}

describe('caller session tab activation authority (C3)', () => {
  it('mounts a window-listed pending surface through the window, never here', () => {
    expect(classifySessionTabActivation(evidence({}))).toBe('mount-in-window')
  })

  it('materializes a window-listed surface whose leaf the window already mounts', () => {
    expect(classifySessionTabActivation(evidence({ mountedGraphLeaf: true }))).toBe('materialize')
  })

  it('treats confirmed absence from the current owner publication as tab_not_found', () => {
    for (const kind of ['window', 'persisted'] as const) {
      const publication = { kind, listed: false }
      const verdict = classifySessionTabActivation(evidence({ publication }))
      expect(verdict).toBe('absent')
      expect(() => assertSessionTabActivationAllowed(verdict, publication)).toThrow('tab_not_found')
    }
  })

  it.each(['no-publisher', 'graph-not-ready', 'inventory-not-authoritative'] as const)(
    'refuses retryably while the publication is still loading (%s)',
    (reason) => {
      const publication = { kind: 'unavailable' as const, reason }
      const verdict = classifySessionTabActivation(evidence({ publication }))
      expect(verdict).toBe('unverifiable')
      let thrown: unknown
      try {
        assertSessionTabActivationAllowed(verdict, publication)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toMatchObject({ code: 'session_tab_unverifiable', data: { reason } })
      expect(isRetryableSessionTabActivationRefusal(thrown)).toBe(true)
      expect((thrown as Error).message).not.toContain('tab_not_found')
    }
  )

  it('lets a live runtime-owned binding attach but never recreate, whatever the publication', () => {
    for (const publication of [
      { kind: 'unavailable', reason: 'graph-not-ready' },
      { kind: 'window', listed: false },
      { kind: 'persisted', listed: false }
    ] as const) {
      expect(classifySessionTabActivation(evidence({ publication, liveRuntimeOwned: true }))).toBe(
        'attach'
      )
    }
  })

  it('materializes a positively owned serve/SSH binding only when the window does not list it', () => {
    for (const publication of [
      { kind: 'unavailable', reason: 'no-publisher' },
      { kind: 'window', listed: false },
      { kind: 'persisted', listed: false }
    ] as const) {
      expect(
        classifySessionTabActivation(evidence({ publication, runtimeOwnedBinding: true }))
      ).toBe('materialize')
    }
    // Why: a surface the window lists is mounted there, acknowledged, never recreated beside it.
    expect(
      classifySessionTabActivation(
        evidence({ publication: { kind: 'window', listed: true }, runtimeOwnedBinding: true })
      )
    ).toBe('mount-in-window')
  })

  it('restores a surface with no window only when the persisted session lists it', () => {
    expect(
      classifySessionTabActivation(evidence({ publication: { kind: 'persisted', listed: true } }))
    ).toBe('materialize')
    expect(
      classifySessionTabActivation(evidence({ publication: { kind: 'persisted', listed: false } }))
    ).toBe('absent')
  })

  it('refuses a ready surface only a stale snapshot keeps listed', () => {
    expect(
      classifySessionTabActivation(
        evidence({ publication: { kind: 'window', listed: false }, surfaceReady: true })
      )
    ).toBe('absent')
    expect(
      classifySessionTabActivation(
        evidence({ publication: { kind: 'window', listed: true }, surfaceReady: true })
      )
    ).toBe('attach')
    // Why: attaching starts nothing, so an unverifiable publication does not block a live surface.
    expect(
      classifySessionTabActivation(
        evidence({
          publication: { kind: 'unavailable', reason: 'graph-not-ready' },
          surfaceReady: true
        })
      )
    ).toBe('attach')
  })

  it('classifies a missing row by publication availability alone', () => {
    expect(classifyMissingSessionTab({ kind: 'window', listed: false })).toBe('absent')
    expect(classifyMissingSessionTab({ kind: 'persisted', listed: false })).toBe('absent')
    expect(
      classifyMissingSessionTab({ kind: 'unavailable', reason: 'inventory-not-authoritative' })
    ).toBe('unverifiable')
  })
})

describe('retryable refusal recognition', () => {
  it('recognizes the codes and keeps tab_not_found and unrelated errors out', () => {
    expect(isRetryableSessionTabActivationRefusal({ code: 'session_tab_mount_failed' })).toBe(true)
    expect(isRetryableSessionTabActivationRefusal(new Error('session_tab_unverifiable'))).toBe(true)
    expect(isRetryableSessionTabActivationRefusal(new Error('tab_not_found'))).toBe(false)
    expect(isRetryableSessionTabActivationRefusal({ code: 'runtime_error' })).toBe(false)
    expect(isRetryableSessionTabActivationRefusal(null)).toBe(false)
  })
})
