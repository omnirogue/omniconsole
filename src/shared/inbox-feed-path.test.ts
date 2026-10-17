import { describe, expect, it } from 'vitest'
import { isInboxFeedPath } from './inbox-feed-path'
describe('Inbox feed boundary', () => {
  it.each([
    '/projects',
    '/threads?project_id=proj_1',
    '/threads?project_id=proj_1&limit=20&cursor=msg_2',
    '/threads?project_id=proj_1&limit=20&view=archived',
    '/rooms?project_id=proj_1&limit=20',
    '/rooms/room_1',
    '/rooms/room_1/messages?limit=20&cursor=post_2'
  ])('allows Work message and discussion reads %s', (path) => {
    expect(isInboxFeedPath(`/api/estate/peers${path}`)).toBe(true)
  })
  it.each([
    '/api/estate/peers/threads',
    '/api/estate/peers/rooms',
    '/api/estate/peers/rooms/r?employee_id=emp_other',
    '/api/estate/peers/rooms/r/messages?limit=20&limit=20',
    '/api/estate/peers/rooms/r/messages?token=secret',
    '/api/estate/peers/directory?project_id=proj_1',
    '/api/estate/peers/threads/msg_1?project_id=proj_1',
    '/api/estate/peers/threads?project_id=p&project_id=q',
    '/api/estate/peers/threads?project_id=p&view=all',
    '/api/estate/peers/threads?project_id=p&view=archived&employee_id=emp_other',
    '/api/estate/peers/rooms?project_id=p&view=archived',
    '/api/estate/peers/rooms/r/join',
    '/api/estate/peers/projects?admin=true',
    '/api/estate/peers/rooms?project_id=p&limit=200',
    '/api/estate/peers/threads/m?project_id=p&token=secret',
    '/api/estate/peers/../../../admin',
    '/api/estate/peers/rooms/r#fragment',
    'https://evil.invalid/api/estate/peers/projects',
    '//evil.invalid/api/estate/peers/projects',
    '/api/estate/peers/rooms/r/messages?cursor=../../admin'
  ])('rejects unapproved paths %s', (path) => {
    expect(isInboxFeedPath(path)).toBe(false)
  })
  it.each([
    '/api/gtd/hub/api/handoffs?assignee=emp_uma',
    '/api/gtd/hub/api/handoffs?assignee=emp_uma&view=sent&limit=50',
    '/api/gtd/hub/api/handoffs/hth_abcd1234',
    '/api/gtd/hub/api/employees'
  ])('rejects hub reads; the signed transport carries handoffs %s', (path) => {
    expect(isInboxFeedPath(path)).toBe(false)
  })
})
