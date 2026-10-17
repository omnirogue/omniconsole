import { describe, expect, it } from 'vitest'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import {
  EVIDENCE_RULES,
  graphAbsenceClaim,
  graphCitations,
  graphCitedRange,
  graphCitedSearches,
  graphEvidenceAdmission,
  graphEvidenceRules,
  graphPreVerifiedList,
  graphPreVerifies,
  graphPreVerifyItem,
  graphPreVerifyLines
} from './graph-pre-verify'
import { graphSearchPlan, graphShellWords } from './graph-pre-verify-search'

const item = (fields: Partial<Parameters<typeof graphPreVerifyItem>[0]> = {}) => ({
  key: 'find.r1.1',
  title: 'Inverted check',
  detail: 'The comparison is inverted.',
  location: 'src/cache.ts:10',
  excerpt: 'if (entry.expires > now) {',
  trigger: 'reading an expired entry',
  ...fields
})

describe('the frozen evidence rules', () => {
  it("are frozen only for Discover, whose Verify reviews its finders' quoted results", () => {
    const discover = workflowTemplate('discover', ['claude'])
    expect(graphEvidenceAdmission(discover, true)).toEqual({ evidenceRules: EVIDENCE_RULES })
    // Knowledge only: no files to check, and its finders may have no tools to search with.
    expect(graphEvidenceAdmission(discover, false)).toEqual({})
    expect(graphPreVerifiedList(discover, 'find')).toBe(true)
    expect(graphPreVerifiedList(discover, 'scout')).toBe(false)
    expect(graphEvidenceAdmission(workflowTemplate('council', ['claude']), true)).toEqual({})
    // Both list quoted results, but Quick Discover has no review and Investigate is out of scope.
    const quick = workflowTemplate('quick-discover', ['claude'])
    expect(graphEvidenceAdmission(quick, true)).toEqual({})
    expect(graphPreVerifiedList(quick, 'find')).toBe(false)
    expect(
      graphEvidenceAdmission(workflowTemplate('investigate', ['claude', 'codex']), true)
    ).toEqual({})
    // A Discover whose Verify no longer reviews the finders' list checks nothing.
    const unreviewed = {
      ...discover,
      steps: discover.steps.map((step) =>
        step.id === 'verify' ? { ...step, forEach: undefined } : step
      )
    }
    expect(graphEvidenceAdmission(unreviewed, true)).toEqual({})
  })

  it('are read back from the host, and refused when newer than this build', () => {
    expect(graphEvidenceRules({ host: { evidenceRules: 2 } })).toEqual({ evidenceRules: 2 })
    expect(graphEvidenceRules({ host: {} })).toEqual({})
    expect(graphEvidenceRules({})).toEqual({})
    expect(graphEvidenceRules({ host: { evidenceRules: '3' } })).toEqual({})
    expect(() => graphEvidenceRules({ host: { evidenceRules: 3 } })).toThrow(
      'Unsupported evidence rules: 3'
    )
  })

  it('turn the pre-verify on only from rules 2', () => {
    expect(graphPreVerifies({})).toBe(false)
    expect(graphPreVerifies({ evidenceRules: 1 })).toBe(false)
    expect(graphPreVerifies({ evidenceRules: EVIDENCE_RULES })).toBe(true)
  })
})

describe('what a result cites', () => {
  it('reads a line range from the location', () => {
    expect(graphCitedRange('src/a.ts:10-14')).toEqual({ file: 'src/a.ts', line: 10, end: 14 })
    expect(graphCitedRange('`src/a.ts#L3-L5`')).toEqual({ file: 'src/a.ts', line: 3, end: 5 })
    expect(graphCitedRange('src/a.ts:10')).toEqual({ file: 'src/a.ts', line: 10 })
    expect(graphCitedRange('src/a.ts:10-4')).toEqual({ file: 'src/a.ts', line: 10 })
    expect(graphCitedRange('the onboarding survey')).toBeUndefined()
  })

  it('lists the location first, then every path:line in the text, once each', () => {
    const citations = graphCitations({
      location: 'src/a.ts:10-12',
      title: 'Called from src\\b.ts:4',
      detail:
        'See src/a.ts:10, lib/c.py#L7-L9, config.json:2 and https://x.dev/page.ts:3; notes.txt:1 is not code.'
    })
    expect(citations).toEqual([
      { file: 'src/a.ts', line: 10, end: 12 },
      { file: 'src/b.ts', line: 4 },
      { file: 'lib/c.py', line: 7, end: 9 },
      { file: 'config.json', line: 2 }
    ])
  })

  it('keeps at most eight citations', () => {
    const detail = Array.from({ length: 12 }, (_, at) => `src/f${at}.ts:${at + 1}`).join(' ')
    expect(graphCitations({ location: 'src/a.ts:1', title: '', detail })).toHaveLength(8)
  })

  it('finds an absence claim, in any of its usual words', () => {
    expect(graphAbsenceClaim({ title: 'The handler is not wired', detail: '' })).toBe(
      'is not wired'
    )
    expect(graphAbsenceClaim({ title: 'Handler not wired', detail: '' })).toBe('not wired')
    expect(graphAbsenceClaim({ title: 'x', detail: 'This is Never Called anywhere.' })).toBe(
      'never called'
    )
    expect(graphAbsenceClaim({ title: 'x', detail: 'The file does not exist.' })).toBe(
      'does not exist'
    )
    expect(graphAbsenceClaim({ title: 'x', detail: 'A guard is missing.' })).toBe('missing')
    expect(graphAbsenceClaim({ title: 'Inverted check', detail: 'It loops.' })).toBeUndefined()
  })

  it('reads the rg searches it gives, in backticks or on their own line', () => {
    const text = [
      'I ran `rg -n "startWatcher" src` and found nothing.',
      '$ rg -w stopWatcher src/main',
      'rg startWatcher src',
      'Also `grep -r x .` and `rg -n "startWatcher" src` again.'
    ].join('\n')
    expect(graphCitedSearches(text)).toEqual([
      'rg -n "startWatcher" src',
      'rg -w stopWatcher src/main',
      'rg startWatcher src'
    ])
  })
})

describe('the facts frozen into the request', () => {
  it('holds the citations, the absence and its searches, and a probe of the quote', () => {
    expect(
      graphPreVerifyItem(
        item({
          title: 'startWatcher is never called',
          detail: 'Nothing starts it: `rg -n startWatcher src` finds only the definition.',
          excerpt: 'export function startWatcher() {\n  ...\n}'
        })
      )
    ).toEqual({
      key: 'find.r1.1',
      citations: [{ file: 'src/cache.ts', line: 10 }],
      code: true,
      absence: 'never called',
      searches: ['rg -n startWatcher src'],
      probe: 'export function startWatcher() {'
    })
  })

  it('reads searches from the trigger, and only for an absence claim', () => {
    const withAbsence = graphPreVerifyItem(
      item({ detail: 'The guard is missing.', trigger: '`rg guardExpiry src`' })
    )
    expect(withAbsence?.searches).toEqual(['rg guardExpiry src'])
    const without = graphPreVerifyItem(item({ detail: 'Inverted: `rg expires src`.' }))
    expect(without).not.toHaveProperty('absence')
    expect(without?.searches).toEqual([])
  })

  it('has no probe for a short quote or a location that is not code', () => {
    expect(graphPreVerifyItem(item({ excerpt: 'x()' }))).not.toHaveProperty('probe')
    const prose = graphPreVerifyItem(
      item({ location: 'the onboarding survey', detail: 'See src/survey.ts:3.' })
    )
    expect(prose).toMatchObject({ code: false, citations: [{ file: 'src/survey.ts', line: 3 }] })
    expect(prose).not.toHaveProperty('probe')
  })

  it('is none for a result that cites nothing and claims no absence', () => {
    expect(
      graphPreVerifyItem(item({ location: 'the onboarding survey', detail: 'It is vague.' }))
    ).toBeUndefined()
    expect(
      graphPreVerifyItem(item({ location: 'the onboarding survey', detail: 'A step is missing.' }))
    ).toMatchObject({ citations: [], code: false, absence: 'missing' })
  })
})

describe("the reviewer's lines", () => {
  it('say what was found for each citation and search', () => {
    expect(
      graphPreVerifyLines({
        citations: [
          { file: 'a.ts', line: 2, status: 'ok', lines: 3 },
          { file: 'b.ts', line: 9, end: 12, status: 'past-end', lines: 4, at: 'pkg/b.ts' },
          { file: 'c.ts', line: 1, status: 'absent' },
          { file: 'd.ts', line: 1, status: 'unknown', why: 'outside the workspace' }
        ],
        absence: 'never called',
        searches: [
          { search: 'rg x', hits: ['a.ts:2'], more: true },
          { search: 'rg y', hits: [] },
          { search: 'rg -u z', error: 'the app does not re-run -u' }
        ],
        flags: []
      })
    ).toEqual([
      '`a.ts:2`: exists, lines in range (3 lines).',
      '`b.ts:9-12` (found as `pkg/b.ts`): past the end of the file (4 lines).',
      '`c.ts:1`: no such file in the workspace.',
      '`d.ts:1`: not checked (outside the workspace).',
      'Search `rg x` re-run: matches at a.ts:2 and more.',
      'Search `rg y` re-run: no matches.',
      'Search `rg -u z`: not re-run (the app does not re-run -u).'
    ])
    expect(
      graphPreVerifyLines({ citations: [], absence: 'missing', searches: [], flags: [] })
    ).toEqual(['It claims an absence ("missing") but gives no search for it.'])
  })
})

describe('a finder search, as the app re-runs it', () => {
  it('splits shell words, ending at a pipe', () => {
    expect(graphShellWords(`rg -n "a b" 'c d' e\\ f "x\\"y" | wc -l`)).toEqual([
      'rg',
      '-n',
      'a b',
      'c d',
      'e f',
      'x"y'
    ])
    expect(graphShellWords('rg ""')).toEqual(['rg', ''])
  })

  it('refuses anything but one plain command', () => {
    for (const command of ['rg x; rm -rf /', 'rg x && ls', 'rg $(id)', 'rg `id`', 'rg x > out']) {
      expect(graphShellWords(command)).toEqual({ refused: 'it is more than one plain command' })
    }
    expect(graphShellWords('rg "x')).toEqual({ refused: 'a quote is not closed' })
  })

  it('keeps matching and scope options, and drops output ones', () => {
    expect(
      graphSearchPlan(
        'rg -nwi --type ts -g "*.ts" -C 3 --max-count=2 --fixed-strings "start(" src lib'
      )
    ).toEqual({
      options: ['-w', '-i', '--type', 'ts', '--glob', '*.ts', '-F'],
      patterns: ['start('],
      paths: ['src', 'lib']
    })
    expect(graphSearchPlan('rg -e one --regexp=two -tts -- -dash src')).toEqual({
      options: ['--type', 'ts'],
      patterns: ['one', 'two'],
      paths: ['-dash', 'src']
    })
  })

  it('refuses a search it cannot re-run as written', () => {
    expect(graphSearchPlan('grep -r x .')).toEqual({ refused: 'it is not an rg search' })
    expect(graphSearchPlan('rg')).toEqual({ refused: 'it has no pattern' })
    expect(graphSearchPlan('rg -n')).toEqual({ refused: 'it has no pattern' })
    expect(graphSearchPlan('rg --pre cat x')).toEqual({ refused: 'the app does not re-run --pre' })
    expect(graphSearchPlan('rg -u x')).toEqual({ refused: 'the app does not re-run -u' })
    expect(graphSearchPlan('rg -v x')).toEqual({ refused: 'the app does not re-run -v' })
    expect(graphSearchPlan('rg --hidden x')).toEqual({
      refused: 'the app does not re-run --hidden'
    })
    expect(graphSearchPlan('rg --type')).toEqual({ refused: '--type has no value' })
    expect(graphSearchPlan('rg x -g')).toEqual({ refused: '-g has no value' })
    expect(graphSearchPlan('rg --ignore-case=yes x')).toEqual({
      refused: 'the app does not re-run --ignore-case'
    })
    expect(graphSearchPlan('rg x; id')).toEqual({ refused: 'it is more than one plain command' })
  })
})
