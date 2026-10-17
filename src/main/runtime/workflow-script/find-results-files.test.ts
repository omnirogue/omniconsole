import { describe, expect, it } from 'vitest'
import type { WorkflowFindTrail } from '../../../shared/workflow-find-trail'
import { findResultsCsv, findResultsMarkdown, findResultsStem } from './find-results-files'

const TRAIL: WorkflowFindTrail = {
  stage: 'done',
  pool: 3,
  source: 'generated',
  top: 2,
  keep: 2,
  overall: [],
  byCriterion: [],
  criteria: ['Cheap to start', 'Fast to revenue'],
  rows: [
    {
      key: 'a',
      title: 'Crumb & Co, "the" bakery',
      detail: 'Line one\nline two',
      judgeText: 'Crumb & Co, "the" bakery: Line one\nline two',
      by: 'Claude',
      score: 3.456,
      scores: [3.1, null],
      finalPlace: 1,
      finalist: true,
      kept: true
    },
    {
      key: 'b',
      title: '=HYPERLINK("http://x")',
      detail: '-5% off, +1 more',
      judgeText: '=HYPERLINK("http://x"): -5% off, +1 more',
      by: 'Codex',
      score: 2,
      scores: [2, 4],
      finalPlace: 2,
      finalist: true,
      kept: true
    },
    {
      key: 'c',
      title: '@Unscored',
      detail: '',
      judgeText: '@Unscored',
      by: 'your list',
      scores: [null, null]
    }
  ]
}

describe('the Find results files', () => {
  it('lists every option and score as CSV a spreadsheet opens safely', () => {
    const csv = findResultsCsv(TRAIL)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    const lines = csv.slice(1).split('\r\n')
    expect(lines[0]).toBe(
      'rank,option,detail,from,jev_score,Cheap to start,Fast to revenue,final_place,finalist,kept'
    )
    expect(lines[1]).toBe(
      '1,"Crumb & Co, ""the"" bakery","Line one\nline two",Claude,3.46,3.1,,1,yes,yes'
    )
    // Text a spreadsheet would run as a formula stays text.
    expect(lines[2]).toBe(`2,"'=HYPERLINK(""http://x"")","'-5% off, +1 more",Codex,2,2,4,2,yes,yes`)
    expect(lines[3]).toBe("3,'@Unscored,,your list,,,,,,")
    expect(lines.at(-1)).toBe('')
  })

  it('writes the question, the rubric, the report and every option into the Markdown file', () => {
    const markdown = findResultsMarkdown({
      task: 'Name the bakery\nfor the high street',
      rubric: '- Cheap to start\n- Fast to revenue',
      report: '## Best option: Crumb & Co\n\nWhy.',
      trail: TRAIL
    })
    expect(markdown).toContain('# Find the best')
    expect(markdown).toContain('**Asked:**\n\n> Name the bakery\n> for the high street')
    expect(markdown).toContain('**What good meant:**\n\n> - Cheap to start\n> - Fast to revenue')
    expect(markdown).toContain('## Best option: Crumb & Co')
    expect(markdown).toContain('## Every option, best first (3)')
    expect(markdown).toContain(
      '1. **Crumb & Co, "the" bakery**\n   JEV 3.5 of 4 · Cheap to start 3.1 · final place 1 · from Claude\n\n   Line one\n   line two'
    )
    expect(markdown).toContain('3. **@Unscored**\n   not scored by JEV · from your list')
    expect(markdown.endsWith('\n')).toBe(true)
  })

  it("adds GitHub's facts, in their own column, when the options are repositories", () => {
    const facts = 'GitHub facts for timgit/pg-boss (fetched 2026-09-23): 2,134 stars · license MIT'
    const trail = {
      ...TRAIL,
      rows: [{ ...TRAIL.rows![0]!, facts }, TRAIL.rows![1]!, TRAIL.rows![2]!]
    }
    const lines = findResultsCsv(trail).slice(1).split('\r\n')
    expect(lines[0]!.endsWith(',kept,github')).toBe(true)
    expect(lines[1]!.endsWith(`,"${facts}"`) || lines[1]!.endsWith(`,${facts}`)).toBe(true)
    expect(lines[2]!.endsWith(',yes,')).toBe(true)
    expect(findResultsMarkdown({ task: 't', rubric: '', report: 'r', trail })).toContain(
      `from Claude\n   ${facts}\n\n   Line one`
    )
    expect(findResultsCsv(TRAIL)).not.toContain('github')
  })

  it("adds the person's check, passed or failed and its score, when versions ran one", () => {
    const trail = {
      ...TRAIL,
      rows: [
        { ...TRAIL.rows![0]!, check: { passed: true, score: 9 } },
        { ...TRAIL.rows![1]!, check: { passed: false } },
        { ...TRAIL.rows![2]!, check: { passed: false, unavailable: true as const } }
      ]
    }
    const lines = findResultsCsv(trail).slice(1).split('\r\n')
    expect(lines[0]!.endsWith(',kept,check,check_score')).toBe(true)
    expect(lines[1]!.endsWith(',yes,passed,9')).toBe(true)
    expect(lines[3]!.endsWith(',could not run,')).toBe(true)
    expect(findResultsMarkdown({ task: 't', rubric: '', report: 'r', trail })).toContain(
      'check passed (score 9)'
    )
  })

  it('names the files by when the run started, a few words of the task and the run', () => {
    const startedAt = new Date(2026, 8, 23, 8, 5).getTime()
    expect(
      findResultsStem(
        'Best ad hooks for the Spring sale — café edition!',
        startedAt,
        'a1b2c3d4-e5f6'
      )
    ).toBe('2026-09-23-0805-best-ad-hooks-for-the-spring-a1b2c3d4')
    expect(findResultsStem('???', startedAt, 'ff00ff00ff')).toBe('2026-09-23-0805-find-ff00ff00')
  })
})
