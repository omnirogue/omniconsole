import { describe, expect, it } from 'vitest'
import { workBoard, workCard } from './console-work-home-contract'
import {
  taskDependencyAddAnswer,
  redactRestrictedDependencies,
  taskDependencyAddRequest,
  taskDependencyGraph
} from './task-dependencies-contract'

const oldCard = { id: 'btk_card0001', title: 'Ship it', status: 'ready' }

describe('task dependency wire contract', () => {
  it('accepts work cards and boards from a console that predates dependency_summary', () => {
    expect(workCard.parse(oldCard).dependency_summary).toBeUndefined()
    expect(workBoard.parse({ items: [oldCard], total: 1, capped: false }).items).toHaveLength(1)
  })

  it('keeps dependency_summary, including a count the console degraded to null', () => {
    const card = workCard.parse({
      ...oldCard,
      dependency_summary: { waiting: 2, satisfied: 1, unmeetable: null, missing: 0 }
    })
    expect(card.dependency_summary).toEqual({
      waiting: 2,
      satisfied: 1,
      unmeetable: null,
      missing: 0
    })
    expect(workCard.parse({ ...oldCard, dependency_summary: null }).dependency_summary).toBeNull()
  })

  it('reduces a restricted edge to a count so no id, condition or state survives', () => {
    const graph = taskDependencyGraph.parse({
      task_id: 'btk_card0001',
      depends_on: [
        {
          task_id: 'btk_open0001',
          title: 'Open one',
          status: 'ready',
          condition: 'DONE',
          state: 'waiting',
          reason: null,
          created_by: null
        },
        {
          task_id: 'btk_hidden01',
          title: null,
          status: null,
          condition: 'DONE',
          state: 'unmeetable',
          reason: 'Depends on a task you do not have access to, which can no longer be completed.',
          created_by: null,
          restricted: true
        }
      ],
      dependents: null,
      truncated: false
    })
    expect(graph.depends_on?.map((edge) => edge.task_id)).toEqual(['btk_open0001'])
    expect(JSON.stringify(graph)).not.toMatch(/btk_hidden01|restricted/)
    expect(graph.hidden).toEqual({ depends_on: 1, dependents: 0, blocking: 1 })
    // An unreadable direction stays null rather than becoming an empty list.
    expect(graph.dependents).toBeNull()
    expect(redactRestrictedDependencies(graph)).toEqual(graph)
  })

  it('refuses a self-dependency before any request', () => {
    expect(
      taskDependencyAddRequest.safeParse({
        taskId: 'btk_card0001',
        dependsOnTaskId: 'btk_card0001'
      }).success
    ).toBe(false)
  })

  it('takes the nested edge from the hub POST answer, or builds one from its top-level keys', () => {
    const nested = taskDependencyAddAnswer('btk_prereq01').parse({
      task_id: 'btk_card0001',
      depends_on_task_id: 'btk_prereq01',
      condition: 'VERIFIED',
      created_by: 'emp_sal',
      state: 'waiting',
      reason: "Waiting for 'Prep' to be verified",
      edge: {
        task_id: 'btk_prereq01',
        title: 'Prep',
        status: 'ready',
        condition: 'VERIFIED',
        state: 'waiting',
        reason: "Waiting for 'Prep' to be verified",
        created_by: 'emp_sal'
      }
    })
    expect(nested).toMatchObject({ task_id: 'btk_prereq01', title: 'Prep' })
    const flat = taskDependencyAddAnswer('btk_prereq01').parse({
      task_id: 'btk_card0001',
      depends_on_task_id: 'btk_prereq01',
      condition: 'DONE',
      created_by: 'emp_sal'
    })
    expect(flat).toMatchObject({ task_id: 'btk_prereq01', condition: 'DONE', title: null })
    expect(
      taskDependencyAddAnswer('btk_prereq01').safeParse({ depends_on_task_id: 'btk_other001' })
        .success
    ).toBe(false)
  })
})
