import { expect, it } from 'vitest'
import { roomInstruction, roomSessionContext, roomTaskContexts } from './inbox-room-context'

it('loads only canonical task cards from this project and deduplicates attention rows', () => {
  expect(
    roomTaskContexts(
      [
        { task_id: 'btk_abcd', title: 'Deploy', project_id: 'proj_one' },
        { task_id: 'btk_abcd', title: 'Deploy duplicate', project_id: 'proj_one' },
        { task_id: 'dcn_abcd', title: 'Decision', project_id: 'proj_one' },
        { task_id: 'btk_else', title: 'Other project', project_id: 'proj_other' },
        { task_id: 'btk_null', title: 'Unknown scope' }
      ],
      'proj_one'
    ).map((item) => item.title)
  ).toEqual(['Deploy duplicate'])
})
it('keeps remote session identity as context, without copying conversation content', () => {
  const session = roomSessionContext({
    rowKey: 'row',
    folderKeyMigration: null,
    sessionKey: 'session',
    worktreeId: 'folder',
    hostId: null,
    tabId: 'tab',
    paneKey: 'pane',
    kind: 'terminal',
    label: 'Login issue',
    workspaceLabel: 'Remote workspace',
    agent: 'Claude',
    unavailable: true
  })
  const text = roomInstruction('proj_one', 'Investigate', 'Can you help?', ['emp_sal'], [session])
  expect(text).toContain('"opening_message": "Can you help?\\n\\nSession: Login issue"')
  expect(text).toContain('"context_references"')
  expect(text).toContain('"kind": "session"')
  expect(text).toContain('"sessionKind": "terminal"')
  expect(text).toContain('stop and report the mismatch')
  expect(text).toContain('"worktreeId": "folder"')
  expect(text).toContain('not an enrollment identity')
  expect(text).not.toContain('"task_id"')
})
it('supports no context and task plus session references without granting execution', () => {
  const text = roomInstruction('proj_one', 'Assess', 'Which option?', ['emp_sal'], [])
  expect(text).toContain('"invite": [')
  expect(text).toContain('do not execute changes')
  expect(text).toContain('`peer_room_open`')
})
it('rejects missing participants and byte-heavy requests', () => {
  expect(() => roomInstruction('p', 'a', 'b', [], [])).toThrow('participant')
  expect(() => roomInstruction('p', 'a', '界'.repeat(700), ['emp_sal'], [])).toThrow('limit')
})
