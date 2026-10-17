import { describe, expect, it } from 'vitest'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import type { GraphEvidenceCheck } from './graph-evidence-check'
import { readGraphItems } from './graph-items'
import { planWorkflowGraph, type GraphCall, type GraphOutcome } from './graph-plan'
import { configFor, drive, task, text } from './graph-test-harness'

const discover = () => workflowTemplate('discover', ['claude', 'codex', 'grok'])

const BRIEF = '## Scope\nSCOPE: OK\n\n## Rubric\n- Is it real?\n- Does it matter?'

/** Each round's finders report: a quoted defect, a misquoted one, one without a quote, an idea. */
function findings(round: number) {
  return [
    {
      title: `Expired entries served in round ${round}`,
      detail: 'An expired entry is returned because the comparison is inverted.',
      location: `src/cache${round}.ts:10`,
      severity: 'high',
      excerpt: 'if (entry.expires > now) {',
      trigger: 'reading an entry after it expired'
    },
    {
      title: `Retries never stop in round ${round}`,
      detail: 'The retry counter is never compared with the limit, so it loops.',
      location: `src/retry${round}.ts:40`,
      severity: 'critical',
      excerpt: 'MISQUOTED retries += 1',
      trigger: 'a request that always fails'
    },
    {
      title: `Unquoted leak in round ${round}`,
      detail: 'A listener is added on every render and never removed.',
      location: `src/leak${round}.ts:7`,
      severity: 'medium',
      excerpt: '',
      trigger: 'rendering the panel twice'
    },
    {
      title: `Onboarding copy is vague in round ${round}`,
      detail: 'The survey never says what the answers are used for.',
      location: 'the onboarding survey',
      severity: 'low',
      excerpt: '',
      trigger: 'a first-time visitor'
    }
  ]
}

function checksFor(call: GraphCall): Record<string, GraphEvidenceCheck> {
  return Object.fromEntries(
    call.evidence!.items.map((item): [string, GraphEvidenceCheck] => [
      item.key,
      item.excerpt.startsWith('MISQUOTED')
        ? { status: 'missing', line: item.line, context: `${item.line} | retries = 0` }
        : { status: 'found', line: item.line, context: `${item.line} | ${item.excerpt}` }
    ])
  )
}

function answer(evidence: (call: GraphCall) => unknown = (call) => ({ checks: checksFor(call) })) {
  return (call: GraphCall): unknown => {
    if (call.evidence) {
      return evidence(call)
    }
    if (call.screen) {
      return { scores: Object.fromEntries(call.screen.candidates.map((entry) => [entry.id, 3])) }
    }
    if (call.id.endsWith('/impact')) {
      const keys = [...call.prompt.matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1]!)
      return { items: keys.map((key) => ({ key, impact: 3, why: 'why', sameAs: '' })) }
    }
    if (call.stepId === 'brief') {
      return text(BRIEF)
    }
    if (call.stepId === 'scout') {
      return {
        items: [{ title: 'Cache', detail: 'The cache layer.', location: 'src', severity: 'none' }]
      }
    }
    if (call.stepId === 'find') {
      return { items: call.agentIndex === 0 ? findings(call.round) : [] }
    }
    return text(call.stepId === 'verify' ? 'Real.\nVERDICT: PASS' : 'The report.')
  }
}

const reviewerPrompt = (calls: GraphCall[], title: string) =>
  calls.find(
    (call) => /\/a\d+$/.test(call.id) && call.stepId === 'verify' && call.prompt.includes(title)
  )!.prompt

describe('Discover checks the finders quotes before any reviewer', () => {
  it('asks each finder for a verbatim quote and a trigger', () => {
    const plan = drive(discover(), answer(), { access: 'workspace-read' })
    const find = plan.calls.find((call) => call.stepId === 'find')!
    expect(find.prompt).toContain('copied exactly as it is in the file')
    expect(find.prompt).toContain('trigger: one line saying what makes it happen')
    const item = find.schema.properties!.items!.items!
    expect(item.required).toEqual(['title', 'detail', 'location', 'severity', 'excerpt', 'trigger'])
    const raw = { items: [{ ...findings(1)[0], excerpt: 'x()' }] }
    expect(readGraphItems(raw, true)![0]).toMatchObject({
      excerpt: 'x()',
      trigger: expect.any(String)
    })
    expect(readGraphItems(raw)![0]).not.toHaveProperty('excerpt')
  })

  it('plans one evidence call a round over the quoted path:line items only', () => {
    const plan = drive(discover(), answer(), { access: 'workspace-read' })
    const evidence = plan.calls.filter((call) => call.evidence)
    expect(evidence.map((call) => call.id)).toEqual(['verify/r1/evidence', 'verify/r2/evidence'])
    expect(evidence[0]!.evidence!.items.map((item) => [item.file, item.line])).toEqual([
      ['src/cache1.ts', 10],
      ['src/retry1.ts', 40]
    ])
    expect(evidence[0]!.seatId).toBe('evidence')
  })

  it('holds every reviewer until the check has answered', () => {
    const config = { ...configFor(discover()), access: 'workspace-read' as const }
    const outcomes = new Map<string, GraphOutcome>()
    const respond = answer()
    let plan = planWorkflowGraph(config, task, outcomes)
    for (let pass = 0; pass < 20; pass++) {
      const next = plan.ready.filter((call) => !call.evidence)
      if (!next.length) {
        break
      }
      next.forEach((call) => outcomes.set(call.id, { value: respond(call) }))
      plan = planWorkflowGraph(config, task, outcomes)
    }
    expect(plan.ready.map((call) => call.id)).toContain('verify/r1/evidence')
    expect(plan.calls.some((call) => call.id.startsWith('verify/r1/find'))).toBe(false)
  })

  it('starts each reviewer from the evidence pack, and flags a quote not found', () => {
    const plan = drive(discover(), answer(), { access: 'workspace-read' })
    const found = reviewerPrompt(plan.calls, 'Expired entries served in round 1')
    expect(found).toContain('Evidence pack (start from it; you may open more files')
    expect(found).toContain('Trigger: reading an entry after it expired')
    expect(found).toContain("The finder's quote:\n```\nif (entry.expires > now) {\n```")
    expect(found).toContain('App check: the quote was found in the file at line 10')
    expect(found).toContain('The real lines of src/cache1.ts around line 10:\n```\n10 | if')
    const missing = reviewerPrompt(plan.calls, 'Retries never stop in round 1')
    expect(missing).toContain('App check: the quoted code was not found in the file')
    expect(missing).toContain('40 | retries = 0')
    expect(reviewerPrompt(plan.calls, 'Unquoted leak in round 1')).toContain(
      'App check: the finder gave no quote'
    )
    expect(reviewerPrompt(plan.calls, 'Onboarding copy is vague in round 1')).toContain(
      'App check: the result names no path:line'
    )
  })

  it('records the status on each item, never refuting or setting aside a missing quote', () => {
    const plan = drive(discover(), answer(), { access: 'workspace-read' })
    const targets = plan.runs.verify!.flatMap((run) => run.targets ?? [])
    const byTitle = (title: string) => targets.find((target) => target.item.title === title)!
    expect(byTitle('Retries never stop in round 1')).toMatchObject({
      tally: 'confirmed',
      item: { evidence: { status: 'missing', line: 40 } }
    })
    expect(byTitle('Retries never stop in round 1').unchecked).toBeUndefined()
    expect(byTitle('Expired entries served in round 2').item.evidence?.status).toBe('found')
    expect(byTitle('Unquoted leak in round 1').item.evidence).toEqual({
      status: 'unquoted',
      line: 7
    })
    expect(byTitle('Onboarding copy is vague in round 1').item.evidence).toEqual({
      status: 'not-code'
    })
    const report = plan.calls.find((call) => call.stepId === 'report')!.prompt
    expect(report).toContain('quote checked in the file')
    expect(report).toContain('quote not found in the file')
  })

  it('marks every quote as not read when the check fails, and says so', () => {
    const plan = drive(
      discover(),
      answer(() => undefined),
      { access: 'workspace-read' }
    )
    const targets = plan.runs.verify![0]!.targets!
    const quoted = targets.filter((target) => /src\/(cache|retry)/.test(target.item.location))
    expect(quoted.map((target) => target.item.evidence)).toEqual([
      { status: 'unreadable' },
      { status: 'unreadable' }
    ])
    expect(plan.notes.join('\n')).toContain(
      "the app could not check the finders' quotes (the check did not finish)"
    )
    expect(reviewerPrompt(plan.calls, 'Expired entries served in round 1')).toContain(
      'the file could not be read, so the quote is unchecked; that says nothing for or against'
    )
    expect(plan.outcome?.state).toBe('completed')
  })

  it('marks the quotes as not read when the workspace was refused', () => {
    const plan = drive(
      discover(),
      answer(() => ({ checks: {}, error: 'The workspace folder is missing.' })),
      { access: 'workspace-read' }
    )
    const statuses = plan.runs.verify![0]!.targets!.map((target) => target.item.evidence?.status)
    expect(statuses.filter((status) => status === 'unreadable')).toHaveLength(2)
    expect(statuses).not.toContain('found')
    expect(plan.notes.join('\n')).toContain('(The workspace folder is missing.)')
  })

  it('never counts a quote the check left out as read', () => {
    const plan = drive(
      discover(),
      answer((call) => ({
        checks: { [call.evidence!.items[0]!.key]: { status: 'found', line: 10 } }
      })),
      { access: 'workspace-read' }
    )
    const retry = plan.runs.verify![0]!.targets!.find((target) =>
      target.item.location.startsWith('src/retry1.ts')
    )!
    expect(retry.item.evidence).toEqual({ status: 'unreadable' })
  })
})
