import { describe, expect, it } from 'vitest'
import { parseFollowUpRequest } from '../../../../shared/session-follow-up-parser'
import type { SessionFollowUpRule } from '../../../../shared/session-follow-up-rule'
import {
  applyFollowUpIntent,
  followUpDraftFromForm,
  formFromRule,
  initialFollowUpForm,
  type FollowUpFormContext
} from './session-follow-up-draft'

const roster = [
  { id: 'emp_iris', name: 'Iriis Ahmed', role: 'QA' },
  { id: 'emp_josh1', name: 'Josh Garcia', department: 'Support' },
  { id: 'emp_josh2', name: 'José García', department: 'Sales' }
]
const context: FollowUpFormContext = {
  workspacePath: '/w',
  manifestPath: '/w/.omni/runs/chn_1/step_1/manifest.md',
  linkedTask: { id: 'btk_abcd1234', title: 'Webinar intro' }
}
const now = new Date(2026, 8, 9, 10, 0)

describe('Next step form', () => {
  it('saves the same rule from the sentence and from the controls', () => {
    const fromSentence = applyFollowUpIntent(
      initialFollowUpForm(context),
      parseFollowUpRequest('Once done, send the final deliverables to Iris for review', now),
      roster,
      context
    )
    expect(fromSentence.problems).toEqual([])
    const fromControls = {
      ...initialFollowUpForm(context),
      action: 'review' as const,
      people: [roster[0]!],
      deliverableMode: 'manifest' as const
    }
    const saved = followUpDraftFromForm(fromControls, context)
    expect(followUpDraftFromForm(fromSentence.form, context)).toEqual(saved)
    expect(saved).toEqual({
      problems: [],
      draft: {
        taskId: 'btk_abcd1234',
        taskTitle: 'Webinar intro',
        recipients: [{ employeeId: 'emp_iris', name: 'Iriis Ahmed' }],
        action: 'review',
        deliverables: { kind: 'manifest', manifestPath: context.manifestPath },
        includeSummary: false,
        note: ''
      }
    })
  })

  it('asks instead of guessing: shared names, unknown people, missing files and task', () => {
    const plainFolder: FollowUpFormContext = { ...context, manifestPath: null, linkedTask: null }
    const applied = applyFollowUpIntent(
      initialFollowUpForm(plainFolder),
      parseFollowUpRequest('when done send the final deliverables to Josh and Bob', now),
      roster,
      plainFolder
    )
    expect(applied.problems.map((problem) => problem.kind)).toEqual([
      'person-choice',
      'person-unknown',
      'final-needs-files'
    ])
    expect(followUpDraftFromForm(applied.form, plainFolder).problems.map((p) => p.kind)).toEqual([
      'no-people',
      'no-task',
      'no-files'
    ])
  })

  it('stops a form with more than 20 people before it is saved', () => {
    const people = Array.from({ length: 21 }, (_, index) => ({
      id: `emp_p${index}`,
      name: `Person ${index}`
    }))
    const form = { ...initialFollowUpForm(context), people }
    expect(followUpDraftFromForm(form, context)).toEqual({
      draft: null,
      problems: [{ kind: 'too-many-people' }]
    })
  })

  it('resolves named files inside the workspace and refuses the rest', () => {
    const form = {
      ...initialFollowUpForm(context),
      people: [roster[0]!],
      deliverableMode: 'files' as const,
      filesText: 'out/report.md\n../x.md'
    }
    expect(followUpDraftFromForm(form, context).problems).toEqual([
      { kind: 'file-outside', path: '../x.md' }
    ])
    const ok = followUpDraftFromForm(
      { ...form, filesText: 'out/report.md\n/w/deck.pptx\nout/report.md', due: '2026-09-11T17:00' },
      context
    )
    expect(ok.draft?.deliverables).toEqual({
      kind: 'files',
      paths: ['/w/out/report.md', '/w/deck.pptx']
    })
    // Why: the console relay's due-date pattern carries no milliseconds.
    expect(ok.draft?.dueAt).toBe(
      new Date('2026-09-11T17:00').toISOString().replace(/\.\d{3}Z$/, 'Z')
    )
  })

  it('prefills an edit from the saved rule', () => {
    const rule: SessionFollowUpRule = {
      revision: 3,
      taskId: 'btk_abcd1234',
      taskTitle: 'Webinar intro',
      sessionLabel: 'Draft',
      recipients: [
        {
          employeeId: 'emp_iris',
          name: 'Iriis Ahmed',
          operationId: 'fu_x_op_1',
          delivery: 'pending'
        }
      ],
      action: 'approve',
      deliverables: { kind: 'files', paths: ['/w/out/report.md', '/elsewhere/a.md'] },
      includeSummary: true,
      note: 'Please approve',
      savedAt: 1
    }
    expect(formFromRule(rule, { ...context, manifestPath: null })).toMatchObject({
      action: 'approve',
      people: [{ id: 'emp_iris', name: 'Iriis Ahmed' }],
      deliverableMode: 'files',
      filesText: 'out/report.md\n/elsewhere/a.md',
      includeSummary: true,
      note: 'Please approve',
      task: { id: 'btk_abcd1234', title: 'Webinar intro' }
    })
  })
})
