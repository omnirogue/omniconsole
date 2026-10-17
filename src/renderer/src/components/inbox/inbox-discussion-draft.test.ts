import { expect, it } from 'vitest'
import { roomDiscussionDraft } from './inbox-discussion-draft'

it('hands off a sequential discussion ending at a human decision without pre-authorizing execution', () => {
  const draft = roomDiscussionDraft({
    project: 'proj_one',
    roomId: 'room_one',
    taskId: 'btk_abcd',
    title: 'Assess release',
    outcome: 'Identify unresolved risks'
  })
  expect(draft.taskId).toBe('btk_abcd')
  expect(
    draft.stages.map(({ key, after, actorType, action }) => ({ key, after, actorType, action }))
  ).toEqual([
    { key: 'collect', after: [], actorType: 'ai', action: 'execute' },
    { key: 'compare', after: ['collect'], actorType: 'ai', action: 'execute' },
    { key: 'recommend', after: ['compare'], actorType: 'ai', action: 'execute' },
    { key: 'human-decision', after: ['recommend'], actorType: 'human', action: 'decide' }
  ])
  for (const stage of draft.stages.slice(0, 3)) {
    expect(stage.prompt).toContain('"project":"proj_one","room_id":"room_one"')
    expect(stage.prompt).toContain('Do not fetch private session transcripts or local files')
    expect(stage.prompt).toContain(
      'Do not invite participants, send direct messages, create tasks, approve work'
    )
    expect(stage.prompt).toContain('reconcile uncertain sends before retrying')
    expect(stage.actorId).toBe('')
  }
  expect(draft.stages[3].provider).toBe('')
  expect(Object.values(draft.admission).every((value) => value === '')).toBe(true)
})
