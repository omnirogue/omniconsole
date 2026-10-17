import { describe, expect, it } from 'vitest'
import { agentProcess } from '../../../session-manage/session-manage-test-fixtures'
import { answerWriteRefusal, livenessContradicts } from './session-manage-answer-write'

describe('answer write admission', () => {
  it('refuses a reservation without a process proof for it, whatever else holds', () => {
    const proof = agentProcess({ ptyId: 'pty-1' })
    const base = {
      ptyId: 'pty-1',
      delivery: { handle: 'term_1', ptyId: 'pty-1' },
      pane: { handle: 'term_1', ptyId: 'pty-1', connected: true },
      provenProcess: proof,
      boundProcess: proof,
      expectedProcess: proof,
      livenessVerdict: null,
      hook: { state: 'blocked' },
      hookRequired: true
    }
    expect(answerWriteRefusal(base)).toBeNull()
    expect(answerWriteRefusal({ ...base, hook: null, hookRequired: false })).toBeNull()
    expect(answerWriteRefusal({ ...base, provenProcess: null })).toContain('not proven')
    expect(
      answerWriteRefusal({ ...base, provenProcess: agentProcess({ ptyId: 'pty-2' }) })
    ).toContain('not proven')
    for (const change of [
      { boundProcess: null },
      { boundProcess: agentProcess({ ptyId: 'pty-1' }) },
      { expectedProcess: agentProcess({ ptyId: 'pty-1', pid: 201 }) },
      { expectedProcess: agentProcess({ ptyId: 'pty-1', startTimeMs: 501 }) },
      { expectedProcess: agentProcess({ ptyId: 'pty-1', incarnationId: 'inc-2' }) },
      { expectedProcess: agentProcess({ ptyId: 'pty-1', rootPid: 999 }) },
      { ptyId: 'pty-2', provenProcess: agentProcess({ ptyId: 'pty-2' }) },
      { pane: { ...base.pane, connected: false } },
      { pane: { ...base.pane, connected: undefined } },
      { pane: { ...base.pane, ptyId: null } },
      { pane: { ...base.pane, handle: 'term_9' } },
      { livenessVerdict: undefined },
      { livenessVerdict: { status: 'unverifiable' as const, reason: 'lost' } },
      { livenessVerdict: { status: 'exited' as const } },
      { livenessVerdict: { status: 'live' as const, ptyIds: [] } },
      { hook: null },
      { hook: undefined },
      { hook: { state: 'done' } }
    ]) {
      expect(answerWriteRefusal({ ...base, ...change })).toEqual(expect.any(String))
    }
  })

  it('reads liveness as contrary evidence only', () => {
    expect(livenessContradicts(null, 'pty-1')).toBe(false)
    expect(livenessContradicts({ status: 'live', ptyIds: ['pty-1'] }, 'pty-1')).toBe(false)
    for (const verdict of [
      undefined,
      { status: 'unverifiable' as const, reason: 'lost' },
      { status: 'exited' as const },
      { status: 'live' as const, ptyIds: [] },
      { status: 'live' as const, ptyIds: ['pty-2'] }
    ]) {
      expect(livenessContradicts(verdict, 'pty-1')).toBe(true)
    }
  })
})
