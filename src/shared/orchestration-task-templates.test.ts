import { describe, expect, it } from 'vitest'
import {
  ORCHESTRATION_TASK_TEMPLATE_IDS,
  getOrchestrationTaskTemplate,
  independentReviewTriggers,
  isOrchestrationTaskTemplateId,
  listOrchestrationTaskTemplates,
  orchestrationAcceptanceLines,
  renderOrchestrationTaskTemplate
} from './orchestration-task-templates'

const base = {
  objective: 'Add a --limit flag to the queue summary.',
  owner: 'Run coordinator, for Sal',
  host: 'Mac Studio',
  branch: 'contributor/queue-limit from origin/main-next',
  scope: 'src/cli/handlers/orchestration/** and its tests',
  acceptance: 'pnpm test src/cli/handlers/orchestration-run-cli.test.ts exits 0',
  evidence: 'Command, host, exit code and output tail in REPORT.md'
}

const extras: Record<string, Record<string, string>> = {
  implement: {},
  verify: { verifyOf: 'Task task_1 (Implement: Add a --limit flag)' },
  'independent-review': {
    reviewOf: 'commit abc1234 on contributor/queue-limit',
    justification: 'Touches the cross-host permission guard.',
    authorModel: 'claude, Claude family'
  },
  'deterministic-qa': { commands: 'pnpm tc — exits 0' },
  release: {
    releasePath: 'Merge PR 1 to main-next, then the install:mac procedure for commit abc1234',
    approval: 'Sal, 3 Oct: "merge and deploy this one"',
    rollback: 'Reinstall OmniConsole.app.previous'
  },
  'live-verification': {
    target: 'OmniConsole 1.12.21 on Mac Studio, commit abc1234',
    checks: 'omni orchestration run-show --queue lists the open task'
  }
}

describe('orchestration task templates', () => {
  it('covers the production stages in order', () => {
    expect(listOrchestrationTaskTemplates().map((template) => template.id)).toEqual([
      'implement',
      'verify',
      'independent-review',
      'deterministic-qa',
      'release',
      'live-verification'
    ])
    expect(isOrchestrationTaskTemplateId('release')).toBe(true)
    expect(isOrchestrationTaskTemplateId('deploy')).toBe(false)
  })

  it('requires owner, host, branch, scope, acceptance and evidence on every stage', () => {
    for (const id of ORCHESTRATION_TASK_TEMPLATE_IDS) {
      const required = getOrchestrationTaskTemplate(id)
        .fields.filter((entry) => entry.required)
        .map((entry) => entry.key)
      expect(required, id).toEqual(
        expect.arrayContaining([
          'objective',
          'owner',
          'host',
          'branch',
          'scope',
          'acceptance',
          'evidence'
        ])
      )
    }
  })

  it('renders a complete brief with the boundaries and report rules', () => {
    for (const id of ORCHESTRATION_TASK_TEMPLATE_IDS) {
      const rendered = renderOrchestrationTaskTemplate(id, { ...base, ...extras[id] })
      if (!rendered.ok) {
        throw new Error(`${id}: ${JSON.stringify(rendered.problems)}`)
      }
      expect(rendered.spec).toContain(`template ${id}@2`)
      expect(rendered.spec).toContain('## Owner\nRun coordinator, for Sal')
      expect(rendered.spec).toContain('## Allowed scope\n')
      expect(rendered.spec).toContain('This task grants no approval.')
      expect(rendered.spec).toContain('A quiet session is not a dead one.')
      expect(rendered.spec).toContain('never zero, never assumed')
      expect(rendered.title).toContain('Add a --limit flag')
    }
  })

  it('numbers Acceptance one check per line, and a launched session reports in its reply', () => {
    const acceptance = '- pnpm tc exits 0\n2. pnpm test src/cli exits 0\n\n  oxlint reports nothing'
    expect(orchestrationAcceptanceLines(acceptance)).toEqual([
      'pnpm tc exits 0',
      'pnpm test src/cli exits 0',
      'oxlint reports nothing'
    ])
    const task = renderOrchestrationTaskTemplate('implement', { ...base, acceptance })
    expect(task.ok && task.spec).toContain(
      '## Acceptance\n- A1. pnpm tc exits 0\n- A2. pnpm test src/cli exits 0\n- A3. oxlint reports nothing'
    )
    expect(task.ok && task.spec).toContain('worker_done')
    const launched = renderOrchestrationTaskTemplate('implement', base, { report: 'reply' })
    expect(launched.ok && launched.spec).toContain(
      'End your final reply with one line per Acceptance item'
    )
    expect(launched.ok && launched.spec).not.toContain('worker_done')
  })

  it('leaves an optional section out instead of rendering it empty', () => {
    const rendered = renderOrchestrationTaskTemplate('implement', base)
    expect(rendered.ok && rendered.spec).not.toContain('## Out of scope')
    const withOptional = renderOrchestrationTaskTemplate('implement', {
      ...base,
      outOfScope: 'The inbox delivery path.'
    })
    expect(withOptional.ok && withOptional.spec).toContain(
      '## Out of scope\nThe inbox delivery path.'
    )
  })

  it('refuses a brief with a missing, placeholder or mistyped field', () => {
    const rendered = renderOrchestrationTaskTemplate('implement', {
      ...base,
      owner: '   ',
      host: '<host>',
      acceptance: 'TBD',
      scop: 'src/'
    })
    expect(rendered.ok).toBe(false)
    expect(rendered.ok ? [] : rendered.problems.map((p) => `${p.field}:${p.problem}`)).toEqual([
      'scop:unknown-field',
      'owner:missing',
      'host:placeholder',
      'acceptance:placeholder'
    ])
  })

  it('never renders a release without an approval that names it', () => {
    const release: Record<string, string> = { ...base, ...extras.release }
    const { approval: _approval, ...withoutApproval } = release
    const rendered = renderOrchestrationTaskTemplate('release', withoutApproval)
    expect(rendered.ok ? [] : rendered.problems).toEqual([
      { field: 'approval', problem: 'missing', detail: 'Approval is required.' }
    ])
  })

  it('never renders a review without its justification and author', () => {
    const rendered = renderOrchestrationTaskTemplate('independent-review', {
      ...base,
      reviewOf: 'commit abc1234'
    })
    expect(rendered.ok ? [] : rendered.problems.map((p) => p.field)).toEqual([
      'justification',
      'authorModel'
    ])
  })

  it('names the guard families that justify an independent review', () => {
    expect(independentReviewTriggers('Rename a label in the settings page.')).toEqual([])
    expect(
      independentReviewTriggers('Tighten the cross-host permission check before a worker starts.')
    ).toEqual(['permissions', 'cross-host'])
    expect(independentReviewTriggers('Add a migration for the refund ledger.')).toEqual([
      'money',
      'migration'
    ])
    const rendered = renderOrchestrationTaskTemplate('implement', {
      ...base,
      objective: 'Refuse a worker start when the SSH host has no verified account.'
    })
    expect(rendered.ok && rendered.reviewTriggers).toEqual(['cross-host'])
  })
})
