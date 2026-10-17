import { describe, expect, it } from 'vitest'
import type { WorkflowSpec } from './workflow-graph'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { screenedDiscover } from './workflow-discover-screen.test-fixture'
import { workflowTemplate } from './workflow-graph-templates'
import { validateWorkflowSpec } from './workflow-graph-validate'
import { withWebPages, workflowWebPageCheck, workflowWebRefusal } from './workflow-web-pages'

const ROUTES = ['claude', 'codex', 'grok'] as const
const research = () => workflowTemplate('research-panel', ROUTES)

describe('where a step may read pages', () => {
  it('lets a Do step read pages, and validation agrees', () => {
    const spec = research()
    expect(workflowWebRefusal(spec, 'research')).toBeUndefined()
    const reading = normalizeWorkflowSpec(
      withWebPages(spec, 'research', ['https://example.com/a']),
      ROUTES
    )
    expect(validateWorkflowSpec(reading, { available: ROUTES }).problems).toEqual([])
  })

  it('refuses judges, Find, a plateau loop’s versions and OpenRouter, as validation does', () => {
    const spec = research()
    expect(workflowWebRefusal(spec, 'critics')).toEqual({ code: 'judge' })
    expect(workflowWebRefusal(spec, 'final')).toEqual({ code: 'judge' })
    const find = workflowTemplate('find', ROUTES)
    const doStep = find.steps.find((step) => step.kind === 'do')!
    expect(workflowWebRefusal(find, doStep.id)).toEqual({ code: 'find' })
    const improve = workflowTemplate('improve', ROUTES)
    expect(workflowWebRefusal(improve, improve.repeat!.do)).toEqual({ code: 'plateau' })
    const routed: WorkflowSpec = {
      ...spec,
      steps: spec.steps.map((step) =>
        step.id === 'critics' ? { ...step, agents: [{ route: 'openrouter' }] } : step
      )
    }
    expect(workflowWebRefusal(routed, 'research')).toEqual({ code: 'openrouter' })
  })

  it('refuses a run whose rubric or final check a model writes, naming both steps', () => {
    expect(workflowWebRefusal(workflowTemplate('discover', ROUTES), 'find')).toBeUndefined()
    const discover = screenedDiscover(ROUTES)
    expect(workflowWebRefusal(discover, 'find')).toEqual({
      code: 'rubric',
      step: 'Verify',
      from: 'Brief'
    })
    expect(workflowWebRefusal(discover, 'find', { ignoreRubric: true })).toBeUndefined()
    const decide = workflowTemplate('decide', ROUTES)
    const reader = decide.steps.find((step) => step.kind === 'do' && !step.inputs.length)!
    expect(workflowWebRefusal(decide, reader.id)?.code).toBe('rubric')
  })

  it('sets, normalises and clears a step’s pages', () => {
    const spec = withWebPages(research(), 'research', [
      'https://example.com/a#part',
      'https://example.com/a'
    ])
    expect(spec.steps[0]!.web).toEqual({ urls: ['https://example.com/a'] })
    expect(withWebPages(spec, 'research', []).steps[0]!.web).toBeUndefined()
  })
})

describe('one more address for a step', () => {
  it('takes a public web address, normalised', () => {
    expect(workflowWebPageCheck('https://Example.com/a#x', [])).toEqual({
      ok: true,
      url: 'https://example.com/a'
    })
  })

  it('refuses what the shared policy refuses, before anything is fetched', () => {
    const reason = (raw: string) => {
      const check = workflowWebPageCheck(raw, [])
      return check.ok ? undefined : check.problem
    }
    expect(reason('file:///etc/passwd')).toEqual({ code: 'address', reason: { code: 'scheme' } })
    expect(reason('https://user:pw@example.com/')).toEqual({
      code: 'address',
      reason: { code: 'credentials' }
    })
    expect(reason('https://example.com:8080/')).toEqual({
      code: 'address',
      reason: { code: 'port' }
    })
    expect(reason('http://localhost/')).toEqual({
      code: 'address',
      reason: { code: 'private-address' }
    })
    expect(reason(`https://example.com/${'a'.repeat(2_001)}`)).toEqual({ code: 'too-long' })
  })

  it('refuses a private or special IP literal in every spelling, and takes a public one', () => {
    for (const host of [
      '127.1',
      '2130706433',
      '0x7f000001',
      '0177.0.0.1',
      '[::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '0.0.0.0',
      '[::]',
      '169.254.169.254',
      '[fd00::1]',
      '100.64.0.1',
      '[64:ff9b::a9fe:a9fe]',
      '10.1.2.3',
      '192.168.0.10',
      '[fe80::1]'
    ]) {
      expect(workflowWebPageCheck(`http://${host}/`, [])).toEqual({
        ok: false,
        problem: { code: 'address', reason: { code: 'private-address' } }
      })
    }
    expect(workflowWebPageCheck('http://93.184.216.34/', []).ok).toBe(true)
    expect(workflowWebPageCheck('https://[2606:4700::1111]/', []).ok).toBe(true)
  })

  it('refuses a page listed twice and the step and run limits', () => {
    const listed = ['https://example.com/a']
    expect(workflowWebPageCheck('https://example.com/a#b', listed)).toEqual({
      ok: false,
      problem: { code: 'listed' }
    })
    const twelve = Array.from({ length: 12 }, (_, index) => `https://example.com/${index}`)
    expect(workflowWebPageCheck('https://example.com/x', twelve)).toEqual({
      ok: false,
      problem: { code: 'step-limit' }
    })
    const others = Array.from({ length: 24 }, (_, index) => `https://other.example/${index}`)
    expect(workflowWebPageCheck('https://example.com/x', [], others)).toEqual({
      ok: false,
      problem: { code: 'run-limit' }
    })
    // A page another step already reads adds nothing to the run's count.
    expect(workflowWebPageCheck('https://other.example/0', [], others).ok).toBe(true)
  })
})
