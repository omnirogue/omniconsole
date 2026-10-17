import { describe, expect, it } from 'vitest'
import {
  describeCheckedFinding,
  parseReviewFindings,
  reviewFindingBlocks,
  REVIEW_FINDINGS_MARKER,
  type CheckedReviewFinding
} from './review-findings'

const line = (findings: unknown) => `${REVIEW_FINDINGS_MARKER} ${JSON.stringify({ findings })}`

describe('parseReviewFindings', () => {
  it('reads the one findings line with command and quote evidence', () => {
    const body = [
      'Summary of the review.',
      line([
        {
          id: 'F1',
          severity: 'blocker',
          claim: 'Null input crashes',
          location: 'src/a.ts:3',
          evidence: { kind: 'command', program: 'node', args: ['repro.js'], expect: 'fail' }
        },
        { severity: 'nit', claim: 'Rename x', evidence: { kind: 'quote', text: 'let x' } }
      ]),
      'VERDICT: REQUEST_CHANGES'
    ].join('\n')
    expect(parseReviewFindings(body)).toEqual([
      {
        id: 'F1',
        severity: 'blocker',
        claim: 'Null input crashes',
        location: 'src/a.ts:3',
        evidence: { kind: 'command', program: 'node', args: ['repro.js'], expect: 'fail' }
      },
      { id: 'F2', severity: 'nit', claim: 'Rename x', evidence: { kind: 'quote', text: 'let x' } }
    ])
  })

  it('refuses a missing, repeated or malformed line instead of guessing', () => {
    expect(parseReviewFindings('VERDICT: APPROVE')).toBeNull()
    expect(parseReviewFindings(`${line([])}\n${line([])}`)).toBeNull()
    expect(parseReviewFindings(`${REVIEW_FINDINGS_MARKER} {not json`)).toBeNull()
    expect(parseReviewFindings(line([{ severity: 'fatal', claim: 'x' }]))).toBeNull()
    expect(
      parseReviewFindings(
        line([{ severity: 'blocker', claim: 'x', evidence: { kind: 'command', program: 'node' } }])
      )
    ).toBeNull()
    expect(parseReviewFindings(line([]))).toEqual([])
  })

  it('blocks on every blocker that carries evidence, including a saved not-reproduced', () => {
    const blocker = { id: 'F1', severity: 'blocker' as const, claim: 'x' }
    expect(reviewFindingBlocks({ ...blocker, status: 'confirmed' })).toBe(true)
    expect(reviewFindingBlocks({ ...blocker, status: 'located' })).toBe(true)
    expect(reviewFindingBlocks({ ...blocker, status: 'unverified' })).toBe(true)
    expect(reviewFindingBlocks({ ...blocker, status: 'not-reproduced' })).toBe(true)
    expect(reviewFindingBlocks({ ...blocker, status: 'needs-evidence' })).toBe(false)
    expect(reviewFindingBlocks({ ...blocker, severity: 'major', status: 'confirmed' })).toBe(false)
  })

  it("keeps a fail command's expected output text instead of discarding it", () => {
    const body = line([
      {
        id: 'F1',
        severity: 'blocker',
        claim: 'crash',
        evidence: {
          kind: 'command',
          program: 'node',
          args: ['repro.js'],
          expect: 'fail',
          output: 'TypeError'
        }
      }
    ])
    expect(parseReviewFindings(body)).toEqual([
      {
        id: 'F1',
        severity: 'blocker',
        claim: 'crash',
        evidence: {
          kind: 'command',
          program: 'node',
          args: ['repro.js'],
          expect: 'fail',
          output: 'TypeError'
        }
      }
    ])
  })

  it('blocks and describes a status it does not know as not proven', () => {
    const unknown = { id: 'F1', severity: 'blocker', claim: 'x', status: 'future' }
    const entry = unknown as unknown as CheckedReviewFinding
    expect(reviewFindingBlocks(entry)).toBe(true)
    expect(describeCheckedFinding(entry)).toContain('not verified; still blocking')
  })

  it('marks supplied but unusable expected output instead of dropping it', () => {
    const evidence = (output: unknown, expect = 'fail') => {
      const command = { kind: 'command', program: 'node', args: ['r.js'], expect, output }
      return parseReviewFindings(
        line([{ id: 'F1', severity: 'blocker', claim: 'x', evidence: command }])
      )?.[0]?.evidence
    }
    expect(evidence('x'.repeat(2_001))).toMatchObject({ outputInvalid: true })
    expect(evidence('x'.repeat(2_001))).not.toHaveProperty('output')
    expect(evidence('   ')).toMatchObject({ outputInvalid: true })
    expect(evidence(42, 'output')).toMatchObject({ expect: 'output', outputInvalid: true })
    expect(evidence(null)).not.toHaveProperty('outputInvalid')
    expect(evidence(undefined)).not.toHaveProperty('outputInvalid')
  })

  it('derives the blocking wording from whether the finding blocks, not from its status', () => {
    const blocker = { id: 'F1', severity: 'blocker' as const, claim: 'x' }
    const located = describeCheckedFinding({ ...blocker, status: 'located' })
    expect(located).toContain('still blocking')
    expect(located.toLowerCase()).not.toContain('not reproduced')
    expect(describeCheckedFinding({ ...blocker, status: 'not-reproduced' })).toContain(
      'still blocking'
    )
    expect(describeCheckedFinding({ ...blocker, status: 'needs-evidence' })).toContain(
      'does not block'
    )
    for (const severity of ['major', 'minor', 'nit'] as const) {
      const suggestion = describeCheckedFinding({ ...blocker, severity, status: 'unverified' })
      expect(suggestion).toContain('a suggestion, never blocks')
      expect(suggestion).not.toContain('still blocking')
    }
  })

  it('reads test-file evidence and rejects an unusable one', () => {
    const one = (evidence: unknown) =>
      parseReviewFindings(line([{ id: 'F1', severity: 'blocker', claim: 'x', evidence }]))?.[0]
        ?.evidence
    expect(one({ kind: 'test', file: 'src/a.test.ts', name: 'adds' })).toEqual({
      kind: 'test',
      file: 'src/a.test.ts',
      name: 'adds'
    })
    expect(one({ kind: 'test', file: 'src/a.test.ts' })).toEqual({
      kind: 'test',
      file: 'src/a.test.ts'
    })
    expect(one({ kind: 'test', file: '' })).toBeUndefined()
    expect(one({ kind: 'test', file: 'a.test.ts', name: 7 })).toBeUndefined()
  })
})
