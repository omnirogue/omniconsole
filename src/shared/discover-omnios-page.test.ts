import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DISCOVER_OMNIOS_MAX_FINDINGS,
  discoverOmniosKey,
  discoverOmniosRun,
  discoverOmniosSummary
} from './discover-omnios-page'
import { discoverOmniosPage } from './discover-omnios-page-html'
import {
  discoverOmniosBrief,
  discoverOmniosDigScript,
  discoverOmniosPublishScript
} from './discover-omnios-brief'
import type { WorkflowRunResult, WorkflowRunTarget } from './workflow-run-result'

function target(
  key: string,
  tally: WorkflowRunTarget['tally'],
  extra: Partial<WorkflowRunTarget> = {}
): WorkflowRunTarget {
  return {
    step: 'verify',
    round: 1,
    key,
    title: `Title ${key}`,
    location: `src/${key}.ts:10`,
    severity: 'high',
    tally,
    votes: [],
    repeats: 0,
    detail: `Detail of ${key}`,
    ...extra
  }
}

const call = (id: string, model: string, state = 'completed') => ({
  id,
  stage: id.split('/')[0],
  model,
  effort: 'high',
  state,
  attempt: 1,
  durationMs: 1,
  tokens: 'unknown',
  costUsd: 'unknown',
  costSource: 'unknown'
})

function result(
  targets: WorkflowRunTarget[],
  ranking: { key: string; rank: number }[],
  markdown = '# Report\n\nCache keys ignore the locale. Fix the key first. It serves the wrong page.\n\n## Confirmed',
  calls = [call('find/a0', 'claude-haiku-5-5'), call('report/a0', 'claude-opus-5-5')]
): WorkflowRunResult {
  return {
    worktreeId: 'w',
    conversationId: 'c',
    executionId: 'e',
    template: 'discover',
    state: 'completed',
    requestedBy: 'Uma',
    request: 'find what slows checkout',
    markdown,
    results: {
      steps: [],
      targets,
      standings: [],
      ranking: ranking.map(({ key, rank }) => ({
        key,
        rank,
        why: `why ${key}`,
        next: `next ${key}`
      }))
    },
    gaps: [],
    timing: { wallClockMs: 30 * 60_000, followedMs: 0 },
    calls,
    usage: { tokens: 'unknown', callsWithTokens: 0 }
  } as unknown as WorkflowRunResult
}

const context = { goal: 'Find what slows checkout', workspace: 'omnirogue' }

describe('44-46: delivery measurement record', () => {
  it('retains every target including refutations, provenance, rounds, votes, JEV and the bill', () => {
    const run = result(
      [
        target('a', 'confirmed', {
          round: 2,
          sourceCallId: 'find/r2/a0',
          alsoFrom: ['find/r2/a1'],
          votes: ['pass'],
          jevVerify: 0.8
        }),
        target('b', 'refuted')
      ],
      []
    )
    const page = discoverOmniosRun(run, { goal: 'Goal', workspace: '/repo' })
    expect(page.measurement?.results.targets).toEqual(run.results.targets)
    expect(page.measurement?.calls).toEqual(run.calls)
    expect(page.measurement?.usage).toEqual(run.usage)
    expect(page.measurement?.results.targets[0]).toMatchObject({
      round: 2,
      sourceCallId: 'find/r2/a0',
      alsoFrom: ['find/r2/a1'],
      votes: ['pass'],
      jevVerify: 0.8
    })
  })
})

describe('a Discover run as its OmniOS page', () => {
  it('orders by the report, sets aside what is not real and ticks Start only for confirmed top three', () => {
    const run = discoverOmniosRun(
      result(
        [
          target('a', 'confirmed'),
          target('b', 'refuted'),
          target('c', 'unverified'),
          target('d', 'confirmed'),
          target('e', 'confirmed'),
          target('f', 'unverified', { unchecked: true }),
          target('g', 'refuted', { refutedBy: 'jev' }),
          target('h', 'unverified', { unchecked: true, screened: true }),
          target('i', 'unverified', {
            preVerify: { flags: [], dropped: 'no file it cites exists' }
          })
        ],
        [
          { key: 'd', rank: 1 },
          { key: 'b', rank: 2 },
          { key: 'c', rank: 3 },
          { key: 'a', rank: 4 }
        ]
      ),
      context
    )
    expect(run.findings.map((f) => [f.n, f.key, f.status, f.recommended])).toEqual([
      [1, 'd', 'confirmed', 'Not now'],
      [2, 'a', 'confirmed', 'Not now'],
      [3, 'e', 'confirmed', 'Not now'],
      [4, 'c', 'unverified', 'Not now'],
      [5, 'f', 'unchecked', 'Not now']
    ])
    expect(run.setAside).toEqual({ refuted: 1, jev: 2, noFile: 1 })
    expect(run.findings[0]).toMatchObject({ why: 'why d', next: 'next d' })
    expect(run.minutes).toBe(30)
    expect(run.models).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
    expect(run.requestedBy).toBe('Uma')
    const page = discoverOmniosPage(run)
    expect(page).toContain('Not reviewed: past the number this run checks')
    expect(page).toContain('Reviewed, but the reviewers did not settle it')
    expect(page).toContain(
      'Also found and set aside: 1 the reviewers refuted, 2 JEV set aside as not real, 1 citing no file that exists.'
    )
  })

  it('never calls a JEV-only confirmation a reviewer’s, nor starts it by default', () => {
    const run = discoverOmniosRun(
      result([target('j', 'confirmed', { confirmedBy: 'jev' })], [{ key: 'j', rank: 1 }]),
      context
    )
    expect(run.findings[0]).toMatchObject({ status: 'jev-confirmed', recommended: 'Not now' })
    expect(discoverOmniosPage(run)).toContain('JEV judged it real; no reviewer settled it')
  })

  it('retains full overflow and shows evidence and controls on the second page', () => {
    const many = Array.from({ length: 11 }, (_, index) => target(`k${index}`, 'confirmed'))
    const run = discoverOmniosRun(result(many, []), context)
    expect(run.findings).toHaveLength(11)
    expect(run.more).toEqual([])
    expect(discoverOmniosPage(run).match(/<fieldset/g)).toHaveLength(DISCOVER_OMNIOS_MAX_FINDINGS)
    const second = discoverOmniosPage(run, 2)
    expect(second.match(/<fieldset/g)).toHaveLength(3)
    expect(second).toContain('Detail of k8')
    expect(second).toContain('data-key="9. Title k8"')
    expect(second).not.toContain('data-key="1. Title k0"')
    expect(second).toContain('Showing 9–11 of 11 findings')
  })

  it('counts a finding once using its latest round and verdict', () => {
    const run = discoverOmniosRun(
      result(
        [
          target('a', 'confirmed'),
          target('a', 'confirmed', { round: 2, repeats: 2 }),
          target('b', 'confirmed'),
          target('b', 'refuted', { round: 2 })
        ],
        [{ key: 'a', rank: 1 }]
      ),
      context
    )
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]).toMatchObject({ key: 'a', repeats: 2 })
    expect(run.setAside.refuted).toBe(1)
    expect(discoverOmniosPage(run)).toContain('1 confirmed; 0 needing review')
  })

  it('defaults the first three confirmed results only with a complete ranking', () => {
    const rows = ['u', 'a', 'b', 'c', 'd'].map((key, i) => ({ key, rank: i + 1 }))
    const targets = rows.map(({ key }) => target(key, key === 'u' ? 'unverified' : 'confirmed'))
    const run = discoverOmniosRun(result(targets, rows), context)
    expect(run.findings.map((f) => [f.key, f.recommended])).toEqual([
      ['a', 'Start'],
      ['b', 'Start'],
      ['c', 'Start'],
      ['d', 'Not now'],
      ['u', 'Not now']
    ])
    expect(discoverOmniosPage(run)).toContain('4 confirmed; 1 needing review')
    const partial = discoverOmniosRun(result(targets, rows.slice(0, 3)), context)
    expect(partial.findings.every((f) => f.recommended === 'Not now')).toBe(true)
    const malformed = discoverOmniosRun(result(targets, [...rows, rows[0]!]), context)
    expect(malformed.rankingComplete).toBe(false)
  })

  it('uses impact for unranked results and renders each confidence signal and effort/risk', () => {
    const r = result(
      [
        target('low', 'confirmed', { impact: { score: 1, why: 'small' } }),
        target('high', 'confirmed', {
          impact: { score: 5, why: 'large' },
          votes: ['pass', 'fail', null],
          repeats: 2,
          jevVerify: 0
        }),
        target('u', 'unverified')
      ],
      [{ key: 'u', rank: 1 }]
    )
    r.results.ranking![0] = {
      ...r.results.ranking![0]!,
      independent: false,
      effort: 'M',
      risk: 'high'
    }
    const run = discoverOmniosRun(r, context)
    expect(run.findings.map((f) => f.key)).toEqual(['high', 'low', 'u'])
    const page = discoverOmniosPage(run)
    expect(page).toContain('Votes: 1 pass, 1 fail, 0 unsure; 1 unanswered · Repeats: 2 · JEV: 0')
    expect(page).toContain('Independent work: no')
    expect(page).toContain('Effort: M · Risk: high')
    expect(page).toContain('Effort: unknown · Risk: unknown')
    expect(page).toContain('JEV: unknown')
  })

  it('marks a Quick Discover finding as read once, never as confirmed', () => {
    const run = discoverOmniosRun(
      result([target('q', 'unverified', { singlePass: true })], [{ key: 'q', rank: 1 }]),
      context
    )
    expect(run.findings[0]).toMatchObject({ status: 'single-pass', recommended: 'Not now' })
  })

  it('leads with the report opening, cut at a sentence', () => {
    expect(discoverOmniosSummary('# Title\n\nOne. Two.\n\nMore')).toBe('One. Two.')
    expect(discoverOmniosSummary(`${'A long sentence here. '.repeat(40)}`, 100)).toMatch(/here\.$/)
    expect(discoverOmniosSummary(null)).toBe('')
    // A fenced block with a blank line inside is never the opening.
    expect(discoverOmniosSummary('```\nconst a = 1\n\nconst b = 2\n```\n\nThe lead. More.')).toBe(
      'The lead. More.'
    )
    // A stop right at the limit still ends the sentence, and a cut never splits a character.
    expect(discoverOmniosSummary('Hello you. Next words here', 10)).toBe('Hello you.')
    expect(discoverOmniosSummary('xxxxx😀😀😀', 6)).toBe('xxxxx😀…')
  })

  it('writes one radio group per finding, keyed short, the recommended one ticked, and no button', () => {
    const title = `Cache <keys> & "locale" ${'and more '.repeat(10)}`.trim()
    const run = discoverOmniosRun(
      result([target('x', 'confirmed', { title })], [{ key: 'x', rank: 1 }]),
      context
    )
    const page = discoverOmniosPage(run)
    expect(page).toContain('<legend>1. Cache &lt;keys&gt; &amp; &quot;locale&quot; and more')
    const key = discoverOmniosKey(run.findings[0])
    expect(Array.from(key).length).toBeLessThanOrEqual(63)
    expect(key.endsWith('…')).toBe(true)
    expect(page).toContain(`data-key="1. Cache &lt;keys&gt; &amp; &quot;locale&quot;`)
    expect(page).toContain('value="Start" data-recommended checked')
    expect(page).toContain('value="Dig deeper">')
    expect(page).toContain('value="Not now">')
    expect(page).toContain("type: 'omni-artifact:edits'")
    expect(page).toContain('edits[group.dataset.key]')
    expect(page).toContain('Cache keys ignore the locale.')
    expect(page).toContain('<summary>The full report</summary>')
    expect(page).not.toMatch(/<button/i)
    expect(page).not.toContain('<keys>')
  })

  it('emits every choice as a structured pick and updates them together on change', () => {
    const page = discoverOmniosPage(
      discoverOmniosRun(result([target('a', 'confirmed')], [{ key: 'a', rank: 1 }]), context)
    )
    const groups = [
      {
        dataset: { n: '1', finding: 'a', key: '1. Title a' },
        querySelectorAll: () => [{ checked: true, value: 'Start' }]
      },
      {
        dataset: { n: '2', finding: 'b', key: '2. Title b' },
        querySelectorAll: () => [{ checked: true, value: 'Dig deeper' }]
      }
    ]
    const messages: { edits: { picks: unknown[] } }[] = []
    let change = () => {}
    runInNewContext(page.match(/<script>([\s\S]*)<\/script>/)![1], {
      document: {
        querySelectorAll: () => groups,
        addEventListener: (_: string, callback: () => void) => {
          change = callback
        }
      },
      parent: { postMessage: (message: (typeof messages)[number]) => messages.push(message) }
    })
    expect(messages[0].edits.picks).toEqual([
      { n: 1, key: 'a', pick: 'Start' },
      { n: 2, key: 'b', pick: 'Dig deeper' }
    ])
    groups[1].querySelectorAll = () => [{ checked: true, value: 'Not now' }]
    change()
    expect(messages[1].edits.picks).toEqual([
      { n: 1, key: 'a', pick: 'Start' },
      { n: 2, key: 'b', pick: 'Not now' }
    ])
  })

  it('shows what the run could not cover above the findings', () => {
    const run = discoverOmniosRun(
      result([target('a', 'confirmed')], [{ key: 'a', rank: 1 }], undefined, [
        call('find/a0', 'claude-haiku-5-5'),
        call('verify/a1', 'grok-4.6-build', 'failed'),
        call('report/a0', 'claude-opus-5-5')
      ]),
      context
    )
    expect(run.gaps).toEqual(['1 of 3 agent calls failed, so their part may be missing.'])
    const page = discoverOmniosPage(run)
    expect(page.indexOf('class="gaps"')).toBeGreaterThan(-1)
    expect(page.indexOf('class="gaps"')).toBeLessThan(page.indexOf('class="finding"'))
  })

  it('says plainly when nothing was found', () => {
    const run = discoverOmniosRun(result([target('r', 'refuted')], []), context)
    expect(run.findings).toEqual([])
    expect(discoverOmniosPage(run)).toContain('<h1>Nothing worth acting on</h1>')
    expect(discoverOmniosPublishScript(run)).not.toContain('--review')
    expect(discoverOmniosBrief(run, '/r/e')).toContain('as a plain page with nothing to decide')
  })
})

describe('the session that brings it to OmniOS', () => {
  const run = discoverOmniosRun(
    result([target('a', 'confirmed')], [{ key: 'a', rank: 1 }]),
    context
  )
  run.executionId = 'parent-run'
  const folders: string[] = []
  afterEach(() => {
    for (const folder of folders.splice(0)) {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  /** A folder with the script and a stand-in CLI that answers like `omni … --json`. */
  function sandbox(name: string, script: string, data = run) {
    const folder = mkdtempSync(join(tmpdir(), 'discover-omnios-act-'))
    folders.push(folder)
    writeFileSync(join(folder, name), script)
    writeFileSync(join(folder, 'findings.json'), JSON.stringify(data))
    const cli = join(folder, 'fake-omni')
    writeFileSync(
      cli,
      [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > args.txt',
        'echo x >> calls.txt',
        `echo '{"ok":true,"result":{"shareUrl":"https://omnios.example/a/1"}}'`
      ].join('\n')
    )
    chmodSync(cli, 0o700)
    const sh = (...args: string[]) =>
      execFileSync('sh', [join(folder, name), ...args], {
        env: { ...process.env, ORCA_CLI_COMMAND: cli },
        encoding: 'utf8',
        stdio: 'pipe'
      })
    const args = () => readFileSync(join(folder, 'args.txt'), 'utf8').trimEnd().split('\n')
    const calls = () => readFileSync(join(folder, 'calls.txt'), 'utf8').trim().split('\n').length
    return { folder, sh, args, calls }
  }

  it('publishes for the team, with no guessed category, quoting the question and summary', () => {
    const script = discoverOmniosPublishScript(
      discoverOmniosRun(
        result([target('a', 'confirmed')], [{ key: 'a', rank: 1 }], "It's Sal's call. Ship it."),
        context
      )
    )
    expect(script).toContain('--summary "$summary"')
    expect(script).toContain('--review --question')
    expect(script).not.toContain('--category')
    expect(script).toContain(
      'if [ -n "$reviewers" ]; then set -- "$@" --reviewers "$reviewers"; fi'
    )
    expect(script).toContain('--audience team --json')
  })

  it.each(['share', 'update'])('adds the requester once when publishing with %s', (mode) => {
    const box = sandbox(
      'publish.sh',
      discoverOmniosPublishScript({ ...run, requestedById: 'emp_uma' })
    )
    for (const [reviewers, expected] of [
      ['', 'emp_uma'],
      ['emp_sal', 'emp_sal,emp_uma'],
      ['emp_uma', 'emp_uma'],
      ['emp_sal,emp_uma,emp_eve', 'emp_sal,emp_uma,emp_eve'],
      ['emp_uma_extra', 'emp_uma_extra,emp_uma']
    ]) {
      box.sh(mode, reviewers)
      expect(box.args().slice(0, 3)).toEqual(['artifacts', mode, 'page.html'])
      expect(box.args().slice(-2)).toEqual(['--reviewers', expected])
    }
  })

  it('keeps publishing without an id unchanged, including a plain page with an id', () => {
    const box = sandbox('publish.sh', discoverOmniosPublishScript(run))
    box.sh('share', '')
    expect(box.args()).not.toContain('--reviewers')
    const empty = discoverOmniosRun(result([], []), context)
    expect(discoverOmniosPublishScript({ ...empty, requestedById: 'emp_uma' })).toBe(
      discoverOmniosPublishScript(empty)
    )
    expect(discoverOmniosBrief({ ...empty, requestedById: 'emp_uma' }, '/runs/e')).toBe(
      discoverOmniosBrief(empty, '/runs/e')
    )
  })

  it('carries the frozen id into page data and explains who publish.sh already addresses', () => {
    const identified = discoverOmniosRun(
      {
        ...result([target('a', 'confirmed')], []),
        requestedById: 'emp_uma'
      },
      context
    )
    expect(identified.requestedById).toBe('emp_uma')
    expect(run).not.toHaveProperty('requestedById')
    const brief = discoverOmniosBrief(identified, '/runs/e')
    expect(brief).toContain(
      'publish.sh already adds Uma, who asked, so <reviewers> lists only the people your standing instructions name.'
    )
    expect(brief).not.toContain(', plus Uma')
    expect(brief).toContain('owner (the person who answered)')
  })

  it('carries the original asker’s id into Dig deeper alongside who answered', () => {
    const box = sandbox(
      'dig.sh',
      discoverOmniosDigScript(
        {
          ...run,
          requestedById: 'emp_uma'
        },
        '/work/shop'
      )
    )
    writeFileSync(join(box.folder, 'brief.md'), 'What is unsure')
    writeFileSync(join(box.folder, 'words.txt'), 'Check the cache')
    box.sh('1', join(box.folder, 'brief.md'), join(box.folder, 'words.txt'), 'Sal')
    expect(box.args()).toContain('--requested-by=Sal')
    expect(box.args().slice(-2)).toEqual(['--requested-by-id', 'emp_uma'])
    expect(discoverOmniosDigScript(run, '/work/shop')).not.toContain('--requested-by-id')
  })

  it('passes every argument through intact and keeps the reply with the link', () => {
    const data = { ...run, summary: "It's $HOME `id`; ok" }
    const box = sandbox('publish.sh', discoverOmniosPublishScript(data), data)
    const out = box.sh('share', 'a@x.com,b@x.com')
    expect(JSON.parse(out).result.shareUrl).toBe('https://omnios.example/a/1')
    expect(JSON.parse(readFileSync(join(box.folder, 'published.json'), 'utf8')).ok).toBe(true)
    const args = box.args()
    expect(args.slice(0, 3)).toEqual(['artifacts', 'share', 'page.html'])
    expect(args[args.indexOf('--summary') + 1]).toBe("It's $HOME `id`; ok")
    expect(args.slice(-2)).toEqual(['--reviewers', 'a@x.com,b@x.com'])
    expect(() => box.sh('delete')).toThrow()
  })

  it('digs into a finding once, carrying the person’s words from their file as written', () => {
    const box = sandbox('dig.sh', discoverOmniosDigScript(run, '/Users/x/Work/shop'))
    writeFileSync(join(box.folder, 'dig-1.md'), 'What is unsure')
    writeFileSync(join(box.folder, 'words-1.txt'), '--quick? "$500" `id` and $(whoami)')
    box.sh('1', join(box.folder, 'dig-1.md'), join(box.folder, 'words-1.txt'), 'Sal Baker')
    const args = box.args()
    expect(args.slice(0, 4)).toEqual(['workflow', 'run', '--template', 'discover'])
    expect(args).toContain('--request=--quick? "$500" `id` and $(whoami)')
    expect(args).toContain('--requested-by=Sal Baker')
    expect(args[args.indexOf('--depth') + 1]).toBe('quick')
    expect(args[args.indexOf('--focus-finding') + 1]).toBe('parent-run:1')
    expect(args[args.indexOf('--worktree') + 1]).toBe('path:/Users/x/Work/shop')
    expect(
      box.sh('1', join(box.folder, 'dig-1.md'), join(box.folder, 'words-1.txt'), 'Sal')
    ).toContain('already being dug into')
    expect(box.calls()).toBe(1)
    expect(() =>
      box.sh('1', join(box.folder, 'dig-1.md'), join(box.folder, 'none.txt'), 'Sal')
    ).toThrow()
  })

  it('tells it how to publish, wait and act, and what it may never do', () => {
    const brief = discoverOmniosBrief(run, '/runs/e')
    expect(brief.split('\n')[0]).toBe(
      'Bring a finished Discover run to OmniOS and act on the answer: Find what slows checkout'
    )
    expect(brief).toContain('bash "/runs/e/publish.sh" share "<reviewers>"')
    expect(brief).toContain(', plus Uma, as emails or emp_ ids (never names')
    expect(brief).toContain('structured picks (number, key, pick)')
    expect(brief).toContain('bash "/runs/e/actions.sh" <page number>')
    expect(brief).toContain('actions.sh calls dig.sh for every selected Dig deeper')
    expect(brief).toContain('Never type a finding title or a person’s words into a command line')
    expect(brief).toContain('host (the run’s execution host)')
    expect(brief).toContain('bash "/runs/e/close.sh" "<at most 500 characters')
    // Every pick reaches decisions.json, so later runs and stats can read it.
    expect(brief).toContain('Not now: bash "/runs/e/decide.sh" <n> not-now')
    expect(brief).toContain('Never move money, send anything to customers')
  })
})

it('50: carries every merged location and claim into the Start contract source', () => {
  const run = discoverOmniosRun(
    result(
      [
        target('a', 'confirmed', {
          alsoReported: [
            {
              title: 'Another place',
              detail: 'Different evidence',
              location: 'src/other.ts:12',
              severity: 'high'
            }
          ]
        })
      ],
      []
    ),
    { goal: 'Improve', workspace: 'repo' }
  )
  expect(run.findings[0].alsoReported).toEqual([
    expect.objectContaining({ location: 'src/other.ts:12' })
  ])
  expect(run.findings[0].detail).toContain('src/other.ts:12')
  expect(run.findings[0].detail).toContain('Different evidence')
  expect(discoverOmniosBrief(run, '/run')).toContain('every merged report and location')
})
