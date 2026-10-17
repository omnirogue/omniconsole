import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { admitHubLinkedLaunch } from './hub-linked-launch-admission'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function setup() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const input = {
    linkedItem: {
      title: 'Create content',
      hubTaskId: 'btk_content',
      hubStateRevision: 3,
      hubNextAction: 'Render a draft'
    },
    launchHubTaskId: 'btk_content',
    coordinatorHandle: 'term_content',
    coordinatorPaneKey: 'content:pane'
  }
  return { db, input }
}

describe('explicit hub linked launch admission', () => {
  it('retains a known next action without inventing an unknown hub revision', () => {
    const { db, input } = setup()
    const admitted = admitHubLinkedLaunch(db, {
      ...input,
      linkedItem: { ...input.linkedItem, hubStateRevision: undefined }
    })
    expect(admitted?.task).toMatchObject({
      hub_state_revision: null,
      hub_next_action: 'Render a draft'
    })
  })
  it('creates one durable run and projection, and reuses them for a repeated launch receipt', () => {
    const { db, input } = setup()
    const first = admitHubLinkedLaunch(db, input)
    const repeated = admitHubLinkedLaunch(db, input)
    expect(first?.run.hub_task_id).toBe('btk_content')
    expect(first?.task).toMatchObject({ hub_state_revision: 3, hub_next_action: 'Render a draft' })
    expect(repeated?.run.id).toBe(first?.run.id)
    expect(repeated?.task.id).toBe(first?.task.id)
    expect(db.listTasks()).toHaveLength(1)
    expect(() => db.updateTaskStatus(first!.task.id, 'completed')).toThrow('projection of omnios')
  })

  it('does not infer admission from only a workspace link, only launch environment, or bare local work', () => {
    const { db, input } = setup()
    const before = db.listRuns().runs
    expect(admitHubLinkedLaunch(db, { ...input, launchHubTaskId: undefined })).toBeNull()
    expect(admitHubLinkedLaunch(db, { ...input, linkedItem: undefined })).toBeNull()
    expect(
      admitHubLinkedLaunch(db, { ...input, linkedItem: undefined, launchHubTaskId: undefined })
    ).toBeNull()
    expect(db.listRuns().runs).toEqual(before)
    expect(db.listTasks()).toEqual([])
  })

  it('refuses mismatched launch identity before writing, and preserves newer hub snapshots', () => {
    const { db, input } = setup()
    expect(() => admitHubLinkedLaunch(db, { ...input, launchHubTaskId: 'btk_other' })).toThrow(
      'differ'
    )
    expect(db.listTasks()).toEqual([])
    const admitted = admitHubLinkedLaunch(db, input)!
    db.refreshHubTaskProjection({
      taskId: admitted.task.id,
      hubTaskId: 'btk_content',
      hubStateRevision: 4,
      hubNextAction: 'Review draft'
    })
    expect(admitHubLinkedLaunch(db, input)?.task).toMatchObject({
      hub_state_revision: 4,
      hub_next_action: 'Review draft'
    })
  })
})
