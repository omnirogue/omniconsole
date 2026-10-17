import { describe, expect, it } from 'vitest'
import type { WorkflowRoute, WorkflowSpec } from './workflow-graph'
import { compileWorkflowDescription } from './workflow-graph-compile'
import { decideWorkflow } from './workflow-graph-decide'
import { screenedDiscover } from './workflow-discover-screen.test-fixture'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { workflowTemplate } from './workflow-graph-templates'
import { describeWorkflow, planWorkflowCalls } from './workflow-graph-topology'
import { validateWorkflowSpec } from './workflow-graph-validate'
import {
  workflowReadsWeb,
  workflowWebReach,
  workflowWebShortAddress,
  workflowWebSources
} from './workflow-graph-web'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']

const research = (web: Record<string, string[]>, extra: object = {}): WorkflowSpec =>
  normalizeWorkflowSpec(
    {
      title: 'Research',
      steps: [
        { id: 'scan', kind: 'do', title: 'Scan', agents: [{}], web: { urls: web.scan } },
        { id: 'research', kind: 'do', title: 'Research', agents: [{}, {}], inputs: ['scan'] },
        { id: 'critics', kind: 'review', title: 'Critics', agents: [{}], inputs: ['research'] },
        { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['research', 'critics'] }
      ].map((step) => (web[step.id] ? { ...step, web: { urls: web[step.id] } } : step)),
      ...extra
    },
    ROUTES
  )

const problems = (spec: WorkflowSpec) =>
  validateWorkflowSpec(spec, { available: ROUTES }).problems.map((problem) => problem.message)

describe('a step that reads web pages', () => {
  it('keeps each address once, normalised, and drops a list with none', () => {
    const spec = research({
      scan: [
        ' https://A.example/one#top ',
        'https://a.example/one',
        'https://b.example',
        '',
        7 as never
      ]
    })
    expect(spec.steps[0]!.web).toEqual({ urls: ['https://a.example/one', 'https://b.example/'] })
    expect(research({ scan: [] }).steps[0]!.web).toBeUndefined()
    expect(workflowReadsWeb(research({ scan: [] }))).toBe(false)
  })

  it('numbers sources W1…Wn over the whole run: readers in run order, then each list in order', () => {
    const spec = research({
      // Listed before its input step, yet read after it: ids follow the run's order.
      research: ['https://c.example/three', 'https://a.example/one#again'],
      scan: ['https://a.example/one', 'https://b.example/two']
    })
    expect(workflowWebSources(spec)).toEqual([
      { id: 'W1', url: 'https://a.example/one', readers: ['scan', 'research'] },
      { id: 'W2', url: 'https://b.example/two', readers: ['scan'] },
      { id: 'W3', url: 'https://c.example/three', readers: ['research'] }
    ])
  })

  it('adds one host call to the bound, on the first reader, and no agent call', () => {
    const plain = planWorkflowCalls(research({}))
    const reading = planWorkflowCalls(research({ research: ['https://a.example/one'] }))
    expect(reading.hostTotal).toBe(plain.hostTotal + 1)
    expect(reading.agentTotal).toBe(plain.agentTotal)
    expect(reading.total).toBe(plain.total + 1)
    expect(reading.perStep.research).toBe(plain.perStep.research! + 1)
    const both = planWorkflowCalls(
      research({ scan: ['https://a.example/one'], research: ['https://b.example/two'] })
    )
    expect(both.perStep.scan).toBe(plain.perStep.scan! + 1)
    expect(both.perStep.research).toBe(plain.perStep.research)
  })

  it('says who reads the pages and that every other step sees only answers', () => {
    const lines = describeWorkflow(
      research({ scan: ['https://a.example/one'], research: ['https://a.example/one'] })
    )
    expect(lines[0]).toBe(
      'The app reads 1 web page once, before any step uses them; only Scan and Research read their text, and every other step sees only what their agents wrote.'
    )
    expect(describeWorkflow(research({})).join('\n')).not.toContain('web page')
  })

  it('shows other steps a source by host and path only', () => {
    expect(workflowWebShortAddress('https://docs.example.com/cache/keys?token=secret#x')).toBe(
      'docs.example.com/cache/keys'
    )
    expect(workflowWebShortAddress('https://docs.example.com/')).toBe('docs.example.com')
  })
})

describe('validation keeps page text away from every judge', () => {
  const on = (kind: string) =>
    normalizeWorkflowSpec(
      {
        steps: [
          { id: 'work', kind: 'do', title: 'Work', agents: [{}, {}] },
          { id: 'check', kind: 'review', title: 'Check', agents: [{}], inputs: ['work'] },
          { id: 'rank', kind: 'rank', title: 'Rank', agents: [{}, {}], inputs: ['work'] },
          { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['work', 'check', 'rank'] }
        ].map((step) =>
          step.kind === kind ? { ...step, web: { urls: ['https://a.example/'] } } : step
        )
      },
      ROUTES
    )

  it.each(['review', 'rank', 'synthesize'])('refuses web pages on a %s step', (kind) => {
    const spec = on(kind)
    expect(spec.steps.find((step) => step.kind === kind)!.web).toBeDefined()
    expect(problems(spec).join(' ')).toContain('only a Do step can read web pages')
    expect(problems(on('do'))).toEqual([])
  })

  it('refuses the Do step an Improve loop repeats, and allows a reader before it', () => {
    const improve = workflowTemplate('improve', ROUTES)
    const looped = normalizeWorkflowSpec(
      {
        ...improve,
        steps: improve.steps.map((step) =>
          step.id === improve.repeat!.do ? { ...step, web: { urls: ['https://a.example/'] } } : step
        )
      },
      ROUTES
    )
    expect(problems(looped).join(' ')).toContain('cannot read web pages')
    const before = normalizeWorkflowSpec(
      {
        ...improve,
        steps: [
          { id: 'sources', kind: 'do', title: 'Sources', web: { urls: ['https://a.example/'] } },
          ...improve.steps.map((step) =>
            step.id === improve.repeat!.do ? { ...step, inputs: ['sources'] } : step
          )
        ]
      },
      ROUTES
    )
    expect(problems(before)).toEqual([])
  })

  it('scores only by rubrics the person wrote: no step\u2019s answer becomes one', () => {
    const withWeb = (spec: WorkflowSpec, id: string) =>
      normalizeWorkflowSpec(
        {
          ...spec,
          steps: spec.steps.map((step) =>
            step.id === id ? { ...step, web: { urls: ['https://a.example/'] } } : step
          )
        },
        ROUTES
      )
    // Discover no longer screens by default, so it reads pages as it is.
    expect(problems(withWeb(workflowTemplate('discover', ROUTES), 'find'))).toEqual([])
    // A Discover screened by its brief: refused wherever the pages are read.
    const discover = screenedDiscover(ROUTES)
    for (const reader of ['brief', 'find']) {
      expect(problems(withWeb(discover, reader))).toContain(
        "Verify takes the rubric JEV and the judges score by from Brief's answer. A run that reads web pages scores only by a rubric you write."
      )
    }
    // Decide's shortlist, comparison and skeptic all read the frame, even when options read pages.
    const decide = withWeb(normalizeWorkflowSpec(decideWorkflow(ROUTES), ROUTES), 'options')
    expect(problems(decide)).toEqual(
      expect.arrayContaining([
        "Develop takes the rubric JEV and the judges score by from Frame's answer. A run that reads web pages scores only by a rubric you write.",
        "Compare takes the rubric JEV and the judges score by from Frame's answer. A run that reads web pages scores only by a rubric you write.",
        "The skeptic checks the recommendation against Frame's answer. A run that reads web pages cannot have its checks written by a model."
      ])
    )
    // A written rubric is the person's own: Discover may read pages with one.
    const written = normalizeWorkflowSpec(
      {
        ...discover,
        steps: discover.steps.map((step) =>
          step.forEach?.screen
            ? { ...step, forEach: { ...step.forEach, screen: { rubric: 'Is it real?' } } }
            : step
        )
      },
      ROUTES
    )
    expect(problems(withWeb(written, 'find'))).toEqual([])
  })

  it('refuses the reviewer\u2019s loop: page text fed back to a rubric source is still refused', () => {
    // The review's FAIL feedback carries page text into the rubric writer's next round.
    const spec = normalizeWorkflowSpec(
      {
        title: 'Loop',
        repeat: { do: 'rubric', review: 'check', until: 'approved', maxRounds: 2 },
        steps: [
          {
            id: 'read',
            kind: 'do',
            title: 'Read',
            agents: [{}],
            web: { urls: ['https://a.example/'] }
          },
          { id: 'rubric', kind: 'do', title: 'Rubric', agents: [{}] },
          { id: 'check', kind: 'review', title: 'Check', agents: [{}], inputs: ['read', 'rubric'] },
          {
            id: 'find',
            kind: 'do',
            title: 'Find',
            agents: [{}],
            inputs: ['check'],
            list: { maxItems: 4 }
          },
          {
            id: 'screen',
            kind: 'review',
            title: 'Screen',
            agents: [{}],
            inputs: ['find', 'rubric'],
            forEach: { step: 'find', limit: 4, screen: { rubricFrom: 'rubric' } }
          },
          { id: 'report', kind: 'synthesize', title: 'Report', inputs: ['screen'] }
        ]
      },
      ROUTES
    )
    // The loop edge is real: the rubric writer is reached by page text though no input says so.
    expect(workflowWebReach(spec).has('rubric')).toBe(true)
    expect(problems(spec)).toContain(
      "Screen takes the rubric JEV and the judges score by from Rubric's answer. A run that reads web pages scores only by a rubric you write."
    )
  })

  it('refuses Find the best', () => {
    const find = workflowTemplate('find', ROUTES)
    const spec = normalizeWorkflowSpec(
      {
        ...find,
        steps: find.steps.map((step) =>
          step.kind === 'do' ? { ...step, web: { urls: ['https://a.example/'] } } : step
        )
      },
      ROUTES
    )
    expect(problems(spec).join(' ')).toContain('Find the best cannot read web pages')
  })

  it.each([
    ['file:///etc/passwd', 'it is not an http or https web address'],
    ['ftp://a.example/x', 'it is not an http or https web address'],
    ['javascript:alert(1)', 'it is not an http or https web address'],
    ['data:text/html,hi', 'it is not an http or https web address'],
    ['https://me:pw@a.example/', 'the address carries a user name or password'],
    ['https://a.example:8080/', 'only ports 80 and 443 are read'],
    ['http://localhost./admin', 'the address points at this computer or a private network'],
    [`https://a.example/${'x'.repeat(2_001)}`, 'the address is too long']
  ])('refuses %s before any fetch', (url, why) => {
    expect(problems(research({ scan: [url] })).join(' ')).toContain(`cannot be read: ${why}.`)
  })

  it('refuses any OpenRouter model in a run that reads pages, reader or not', () => {
    const reading = research({ scan: ['https://a.example/'] })
    for (const id of ['scan', 'critics']) {
      const spec = normalizeWorkflowSpec(
        {
          ...reading,
          steps: reading.steps.map((step) =>
            step.id === id ? { ...step, agents: [{ route: 'openrouter', model: 'x/y' }] } : step
          )
        },
        ROUTES
      )
      expect(problems(spec)).toContain(
        "Reading web pages isn't available with OpenRouter models yet."
      )
    }
    const plain = normalizeWorkflowSpec(
      {
        ...research({}),
        steps: research({}).steps.map((step) =>
          step.id === 'scan' ? { ...step, agents: [{ route: 'openrouter', model: 'x/y' }] } : step
        )
      },
      ROUTES
    )
    expect(problems(plain)).not.toContain(
      "Reading web pages isn't available with OpenRouter models yet."
    )
  })

  it('refuses more than 12 pages in a step and more than 24 in a run', () => {
    const pages = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => `https://a.example/${from + index}`)
    expect(problems(research({ scan: pages(0, 12), research: pages(12, 12) }))).toEqual([])
    expect(problems(research({ scan: pages(0, 13) })).join(' ')).toContain(
      'read at most 12 web pages in one step'
    )
    const spec = research({ scan: pages(0, 12), research: pages(12, 12) })
    spec.steps[0]!.web!.urls.push('https://b.example/one')
    expect(problems(spec).join(' ')).toContain('reads 25 web pages; the limit is 24')
  })
})

describe('the compiler never adds a page address', () => {
  const answer = (urls: string[]) =>
    JSON.stringify({
      title: 'Research',
      steps: [
        { id: 'research', kind: 'do', title: 'Research', agents: [{}, {}], web: { urls } },
        { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['research'] }
      ]
    })

  it('drops the addresses a model wrote, and keeps the ones the person typed', async () => {
    const compiled = await compileWorkflowDescription({
      description: 'Research caching',
      available: ROUTES,
      ask: async () => answer(['https://evil.example/?data=secret'])
    })
    if (!('spec' in compiled)) {
      throw new Error('the compile gave no workflow')
    }
    expect(compiled.spec.steps.map((step) => step.web)).toEqual([undefined, undefined])
    const current = normalizeWorkflowSpec(
      JSON.parse(answer(['https://docs.example.com/cache'])),
      ROUTES
    )
    const edited = await compileWorkflowDescription({
      description: 'Use three researchers',
      current,
      available: ROUTES,
      ask: async () => answer(['https://evil.example/?data=secret'])
    })
    if (!('spec' in edited)) {
      throw new Error('the compile gave no workflow')
    }
    expect(edited.spec.steps[0]!.web).toEqual({ urls: ['https://docs.example.com/cache'] })
    expect(edited.validation.problems).toEqual([])
  })
})
