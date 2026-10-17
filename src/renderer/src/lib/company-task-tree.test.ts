import { describe, expect, it } from 'vitest'
import type { WorkRow } from '../../../shared/backoffice-work-views'
import { buildCompanyTaskTree, companyTaskKey, departmentTaskKey } from './company-task-tree'

const companies = [
  {
    id: 'co_rogue',
    slug: 'omnirogue',
    name: 'OmniRogue',
    status: null,
    count: 3,
    domains: [
      {
        id: 'org_dev',
        name: 'Development',
        count: 2,
        parent_unit_id: null,
        projects: [{ id: 'proj_bots', name: 'OmniConsole', kind: 'project', status: 'active' }]
      },
      { id: 'org_sales', name: 'Sales', count: 0, parent_unit_id: null, projects: [] }
    ]
  },
  { id: 'co_acme', slug: 'acme', name: 'ACME', status: null, count: 0, domains: [] }
]

function task(
  id: string,
  title: string,
  todo: Partial<NonNullable<WorkRow['todo']>> = {},
  extra: Partial<WorkRow> = {}
): WorkRow {
  return {
    key: `row:${id}`,
    source: 'task',
    taskId: id,
    title,
    kind: 'work',
    nextActor: { kind: 'me' },
    why: null,
    what: null,
    actionLabel: null,
    state: (todo.status as string) ?? 'open',
    dueAt: null,
    updatedAt: null,
    repliesWaiting: 0,
    needsYou: false,
    waitingFor: false,
    todo: { task_id: id, title, status: 'open', ...todo },
    ...extra
  }
}

describe('the tree of durable work', () => {
  it('files a task by the card, deepest place first', () => {
    const tree = buildCompanyTaskTree({
      companies,
      rows: [
        task('btk_bots0001', 'Simplify handoffs', {
          company_slug: 'omnirogue',
          org_unit_id: 'org_dev',
          project_id: 'proj_bots'
        }),
        task('btk_dev00001', 'Windows verification', {
          company_slug: 'omnirogue',
          org_unit_id: 'org_dev'
        }),
        task('btk_co000001', 'Company level', { company_slug: 'omnirogue' }),
        task('btk_else0001', 'Somewhere else', { company_slug: 'notacompany' })
      ]
    })
    const rogue = tree.companies[0]!
    expect(rogue.key).toBe(companyTaskKey('omnirogue'))
    const dev = rogue.departments.find((d) => d.name === 'Development')!
    expect(dev.key).toBe(departmentTaskKey('omnirogue', 'org_dev'))
    expect(dev.projects[0]!.tasks.map((t) => t.row.title)).toEqual(['Simplify handoffs'])
    expect(dev.tasks.map((t) => t.row.title)).toEqual(['Windows verification'])
    expect(rogue.tasks.map((t) => t.row.title)).toEqual(['Company level'])
    expect(tree.unfiled.map((t) => t.row.title)).toEqual(['Somewhere else'])
  })

  it('counts what needs a person up the tree and puts it first', () => {
    const tree = buildCompanyTaskTree({
      companies,
      rows: [
        task('btk_calm0001', 'Steady work', {
          company_slug: 'omnirogue',
          org_unit_id: 'org_dev',
          project_id: 'proj_bots'
        }),
        task(
          'btk_ask00001',
          'Needs a decision',
          {
            company_slug: 'omnirogue',
            org_unit_id: 'org_dev',
            project_id: 'proj_bots',
            primary_action: { handoff_thread_id: 'hth_ask' }
          },
          { needsYou: true }
        ),
        // Why: a decision the hub derived names the reader next but no person asked; no ❗.
        task(
          'btk_mail0001',
          'Mail-derived decision',
          {
            company_slug: 'omnirogue',
            org_unit_id: 'org_dev',
            project_id: 'proj_bots',
            decision_id: 'dcn_mail'
          },
          { needsYou: true }
        )
      ]
    })
    const project = tree.companies[0]!.departments[0]!.projects[0]!
    expect(project.tasks.map((t) => t.row.title)).toEqual([
      'Needs a decision',
      'Mail-derived decision',
      'Steady work'
    ])
    expect(project.needsYou).toBe(1)
    expect(tree.companies[0]!.departments[0]!.needsYou).toBe(1)
    expect(tree.companies[0]!.needsYou).toBe(1)
    expect(tree.companies[0]!.open).toBe(3)
  })

  it('sets closed work aside and never counts it as in progress', () => {
    const tree = buildCompanyTaskTree({
      companies,
      rows: [
        task('btk_done0001', 'Finished', {
          company_slug: 'omnirogue',
          org_unit_id: 'org_dev',
          status: 'done',
          kanban_status: 'done'
        }),
        task('btk_stop0001', 'Dropped', { company_slug: 'omnirogue', status: 'cancelled' })
      ]
    })
    expect(tree.closed.map((t) => t.row.title).sort()).toEqual(['Dropped', 'Finished'])
    expect(tree.companies[0]!.open).toBe(0)
    expect(tree.companies[0]!.departments[0]!.tasks).toEqual([])
  })

  it('keeps only real cards, once each — threads and messages are execution, not commitments', () => {
    const thread: WorkRow = {
      ...task('btk_dupe0001', 'Same card twice', { company_slug: 'omnirogue' }),
      key: 'row:thread',
      source: 'received-handoff'
    }
    const message: WorkRow = {
      ...task('btk_dupe0001', 'Same card twice', { company_slug: 'omnirogue' }),
      key: 'row:message',
      taskId: null,
      source: 'message'
    }
    const tree = buildCompanyTaskTree({
      companies,
      rows: [
        task('btk_dupe0001', 'Same card twice', { company_slug: 'omnirogue' }),
        thread,
        message
      ]
    })
    expect(tree.companies[0]!.tasks).toHaveLength(1)
    expect(tree.unfiled).toEqual([])
  })
})
