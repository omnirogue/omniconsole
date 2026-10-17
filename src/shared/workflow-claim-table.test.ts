import { describe, expect, it } from 'vitest'
import {
  renderWorkflowClaimTable,
  settleWorkflowClaims,
  splitWorkflowClaimTable,
  workflowClaimsFromChecks,
  type WorkflowClaimCheck
} from './workflow-claim-table'

const CHECKS: WorkflowClaimCheck[] = [
  { key: 'investigate.r1.1', title: 'Index removed', location: 'src/a.ts:3', tally: 'confirmed' },
  { key: 'investigate.r1.2', title: 'Warm start', location: 'docs/x.md', tally: 'unverified' },
  { key: 'investigate.r1.3', title: 'Old path', location: 'src/b.ts:9', tally: 'refuted' },
  { key: 'investigate.r1.4', title: 'No place', location: '', tally: 'confirmed' },
  {
    key: 'investigate.r1.5',
    title: 'Too many',
    location: 'src/c.ts:1',
    tally: 'unverified',
    unchecked: true
  }
]

const block = (rows: unknown) => `## Answer\nYes.\n\n\`\`\`claims\n${JSON.stringify(rows)}\n\`\`\``

describe('the table of claims', () => {
  it('strips the block and reads each row, defaulting what it cannot read to open', () => {
    const split = splitWorkflowClaimTable(
      block([
        { claim: ' Index\nremoved ', status: 'Confirmed', evidence: 'src/a.ts:3', key: 'k1' },
        { claim: 'Maybe', status: 'likely', evidence: 'src/a.ts:4' },
        { claim: '', status: 'confirmed' },
        'junk'
      ])
    )
    expect(split.markdown).toBe('## Answer\nYes.')
    expect(split.rows).toEqual([
      { claim: 'Index removed', status: 'confirmed', evidence: 'src/a.ts:3', key: 'k1' },
      { claim: 'Maybe', status: 'open', evidence: 'src/a.ts:4' }
    ])
    expect(splitWorkflowClaimTable('No table here.')).toEqual({ markdown: 'No table here.' })
    expect(splitWorkflowClaimTable('Text\n```claims\nnot json\n```').rows).toBeUndefined()
  })

  it('keeps a confirmation only when the fact-check confirmed it and the row names evidence', () => {
    const rows = settleWorkflowClaims(
      [
        { claim: 'A', status: 'confirmed', evidence: 'src/a.ts:3', key: 'investigate.r1.1' },
        { claim: 'B', status: 'confirmed', evidence: 'docs/x.md', key: 'investigate.r1.2' },
        { claim: 'C', status: 'confirmed', evidence: '', key: 'investigate.r1.1' },
        {
          claim: 'D',
          status: 'confirmed',
          evidence: 'could not check the file',
          key: 'investigate.r1.1'
        },
        { claim: 'E', status: 'confirmed', evidence: 'src/e.ts:1' },
        { claim: 'F', status: 'confirmed', evidence: 'src/c.ts:1', key: 'investigate.r1.5' },
        {
          claim: 'G',
          status: 'refuted',
          evidence: 'src/b.ts:9 says otherwise',
          key: 'investigate.r1.3'
        },
        { claim: 'H', status: 'refuted', evidence: 'src/a.ts:3', key: 'investigate.r1.1' },
        { claim: 'I', status: 'open', evidence: '' }
      ],
      CHECKS
    )
    expect(rows.map((row) => [row.claim, row.status, row.note])).toEqual([
      ['A', 'confirmed', undefined],
      ['B', 'open', 'was marked confirmed; the fact-check did not confirm it'],
      ['C', 'open', 'was marked confirmed; it names no evidence'],
      ['D', 'open', 'was marked confirmed; it names no evidence'],
      ['E', 'open', 'was marked confirmed; it was not fact-checked'],
      ['F', 'open', 'was marked confirmed; the fact-check did not reach it'],
      ['G', 'refuted', undefined],
      ['H', 'open', 'was marked refuted; the fact-check confirmed it'],
      ['I', 'open', undefined]
    ])
  })

  it('builds the table from the fact-check when the writer gave none', () => {
    const rows = workflowClaimsFromChecks([
      ...CHECKS,
      {
        key: 'investigate.r1.6',
        title: 'Quoted',
        location: 'src/d.ts:2',
        tally: 'confirmed',
        quote: 'quote checked in the file'
      }
    ])
    expect(rows.map((row) => [row.claim, row.status, row.evidence])).toEqual([
      ['Index removed', 'confirmed', 'src/a.ts:3'],
      ['Quoted', 'confirmed', 'src/d.ts:2 · quote checked in the file'],
      ['Old path', 'refuted', 'src/b.ts:9'],
      ['Warm start', 'open', 'docs/x.md'],
      ['No place', 'open', ''],
      ['Too many', 'open', 'src/c.ts:1']
    ])
    expect(rows.find((row) => row.claim === 'No place')!.note).toBe(
      'confirmed, but it names no evidence'
    )
  })

  it('renders a markdown table with safe cells', () => {
    expect(
      renderWorkflowClaimTable([
        { claim: 'Uses a | pipe', status: 'confirmed', evidence: 'src/a.ts:3' },
        {
          claim: 'Unknown',
          status: 'open',
          evidence: '',
          note: 'was marked confirmed; it names no evidence'
        }
      ])
    ).toBe(
      [
        '## Confirmed, refuted and open',
        '',
        '| Claim | Status | Evidence |',
        '| --- | --- | --- |',
        '| Uses a \\| pipe | Confirmed | src/a.ts:3 |',
        '| Unknown | Open (was marked confirmed; it names no evidence) | — |'
      ].join('\n')
    )
  })
})
