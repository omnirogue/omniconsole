import { describe, expect, it, vi } from 'vitest'
import { renderSessionPrompt } from '../../shared/session-prep-prompt'
import { prepare, revise } from './session-prep-preparer'
import { sessionPrepTaskKind, sessionPrepTaskTemplate } from './session-prep-task-template'

// The paired live benchmark uses these same ten requests, without customer data.
const TEMPLATE_SAMPLES = [
  ['code', 'Fix the login timeout and add a regression test.'],
  ['code', 'Implement keyboard navigation for the settings dialog.'],
  ['research', 'Research the differences between SQLite WAL and rollback journals.'],
  ['research', 'Compare the documented accessibility support of two desktop toolkits.'],
  ['ops', 'Check why the development health endpoint is returning errors; report findings.'],
  ['ops', 'Configure a local log rotation policy using the existing runbook.'],
  ['content', 'Draft a short release note from the supplied changes.'],
  ['content', 'Write a plain-language onboarding guide for new contributors.'],
  ['review', 'Review the authentication PR for regressions; do not change files.'],
  ['review', 'Audit the attached incident report for missing evidence.']
] as const

const fields = {
  title: 'Requested work',
  outcome: 'The requested artifact is ready for review.',
  doneWhen: ['The requested artifact exists.', 'The scope is checked against the request.'],
  decided: [],
  references: [],
  constraints: [],
  assumptions: [],
  blockingQuestion: null,
  changesCode: false
}

describe('task templates', () => {
  it.each(TEMPLATE_SAMPLES)('selects %s without a model call: %s', (kind, request) => {
    expect(sessionPrepTaskKind(request)).toBe(kind)
    expect(sessionPrepTaskTemplate(request)).toContain(`selected by code): ${kind}`)
  })

  it.each([
    ['Fix the code review screen.', 'code'],
    ['Research how to implement an offline cache.', 'research'],
    ['Review the fix for login.', 'review'],
    ['Draft a plan to configure logging.', 'content'],
    ['Help with this task.', 'ops']
  ])('uses the first requested action: %s', (request, kind) => {
    expect(sessionPrepTaskKind(request)).toBe(kind)
  })

  it.each(TEMPLATE_SAMPLES)(
    'fills the %s template and keeps the request first',
    async (_, request) => {
      const item = {
        title: fields.title,
        ask: request,
        anchor: request,
        direct: false,
        changesCode: false
      }
      const runText = vi.fn(async (_input: { prompt: string }) => JSON.stringify(fields))
      const deps = {
        runText,
        agent: 'claude' as const,
        model: 'sonnet',
        effort: 'medium',
        timeoutMs: 360_000
      }
      const input = { request, item, index: 0, siblings: [], context: '', cwd: '/workspace' }
      const prepared = await prepare(input, deps)
      expect(runText).toHaveBeenCalledTimes(1)
      expect(runText.mock.calls[0]?.[0].prompt).toContain(sessionPrepTaskTemplate(request))
      const prompt = renderSessionPrompt({
        ...input,
        fields: prepared,
        batchId: 'sample',
        ask: null,
        unresolved: []
      })
      expect(prompt.startsWith(`Your request (verbatim): "${request}"\n`)).toBe(true)
      await revise({ ...input, fields: prepared, failures: [] }, deps)
      expect(runText.mock.calls[1]?.[0].prompt).toContain(sessionPrepTaskTemplate(request))
    }
  )

  it('preserves whitespace and quotes in the first request block', () => {
    const request = '  Write "hello".\nKeep this line.  '
    const item = {
      title: fields.title,
      ask: request,
      anchor: request,
      direct: false,
      changesCode: false
    }
    const prompt = renderSessionPrompt({
      fields,
      item,
      index: 0,
      request,
      batchId: 'sample',
      ask: null,
      siblings: [],
      unresolved: []
    })
    expect(prompt.startsWith(`Your request (verbatim): "${request}"\n`)).toBe(true)
  })
})
