import { describe, expect, it } from 'vitest'
import { splitWorkflowReportRanking } from './workflow-report-ranking'

const block = (rows: unknown) => `\`\`\`ranking\n${JSON.stringify(rows)}\n\`\`\``

describe('splitWorkflowReportRanking', () => {
  it('strips the block from the report and orders its rows by rank', () => {
    const split = splitWorkflowReportRanking(
      `# Report\n\nTwo results.\n\n${block([
        { key: 'find.r1.3', rank: 2, why: ' Loses data ', next: 'Add a lock', independent: true },
        { key: 'find.r1.1', rank: 1, why: 'Leaks a token', next: 'Rotate it' }
      ])}\n`
    )
    expect(split.markdown).toBe('# Report\n\nTwo results.')
    expect(split.ranking).toEqual([
      { key: 'find.r1.1', rank: 1, why: 'Leaks a token', next: 'Rotate it' },
      { key: 'find.r1.3', rank: 2, why: 'Loses data', next: 'Add a lock', independent: true }
    ])
  })

  it('keeps text a writer put after the block, and reads only the last block', () => {
    const split = splitWorkflowReportRanking(
      `Report\n${block([{ key: 'a', rank: 1, why: 'old', next: 'x' }])}\n${block([
        { key: 'b', rank: 1, why: 'new', next: 'y' }
      ])}\nThanks.`
    )
    expect(split.ranking?.map((row) => row.key)).toEqual(['b'])
    expect(split.markdown).toContain('Thanks.')
    expect(split.markdown).not.toContain('"new"')
  })

  it('drops malformed rows, and never loses the report over a bad block', () => {
    expect(
      splitWorkflowReportRanking(
        `R\n${block([{ key: 'a', rank: 1.5, why: 'w', next: 'n' }, null, { key: 'b', rank: 1, why: 'w', next: 'n' }])}`
      ).ranking
    ).toEqual([{ key: 'b', rank: 1, why: 'w', next: 'n' }])
    expect(splitWorkflowReportRanking('R\n```ranking\n{not json\n```')).toEqual({ markdown: 'R' })
    expect(splitWorkflowReportRanking('R\n```ranking\n{"a":1}\n```')).toEqual({ markdown: 'R' })
    expect(splitWorkflowReportRanking('Plain report')).toEqual({ markdown: 'Plain report' })
  })

  it('never takes report text for the block, nor a fence inside another code block', () => {
    const report = 'Intro\n```ranking\n```\nKeep this paragraph.\n```ts\nconst a = 1\n```'
    expect(splitWorkflowReportRanking(report)).toEqual({
      markdown: 'Intro\n\nKeep this paragraph.\n```ts\nconst a = 1\n```'
    })
    const example = 'How to rank:\n````md\n```ranking\n[]\n```\n````'
    expect(splitWorkflowReportRanking(example)).toEqual({ markdown: example })
  })

  it('accepts only positive whole ranks', () => {
    const rows = [0, -1, 2].map((rank, index) => ({ key: `k${index}`, rank, why: 'w', next: 'n' }))
    expect(splitWorkflowReportRanking(`R\n${block(rows)}`).ranking?.map((row) => row.key)).toEqual([
      'k2'
    ])
  })

  it('recovers a final block missing its closing fence only when it holds the ranking', () => {
    const rows = [{ key: 'a', rank: 1, why: 'w', next: 'n' }]
    expect(splitWorkflowReportRanking(`R\n\`\`\`ranking\n${JSON.stringify(rows)}\n`)).toEqual({
      markdown: 'R',
      ranking: rows
    })
    expect(splitWorkflowReportRanking('R\n```ranking\nnot json')).toEqual({
      markdown: 'R\n```ranking\nnot json'
    })
  })
  it('keeps structured effort and risk, dropping invalid estimates without losing the row', () => {
    const row = { key: 'a', rank: 1, why: 'w', next: 'n' }
    expect(
      splitWorkflowReportRanking(block([{ ...row, effort: 'M', risk: 'high' }])).ranking
    ).toEqual([{ ...row, effort: 'M', risk: 'high' }])
    expect(
      splitWorkflowReportRanking(block([{ ...row, effort: 'huge', risk: 5 }])).ranking
    ).toEqual([row])
  })
})
