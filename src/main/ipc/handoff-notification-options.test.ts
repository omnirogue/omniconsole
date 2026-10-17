import { expect, it } from 'vitest'
import { buildNotificationOptions } from './notification-options'
it('labels handoff arrivals without pretending an agent or task completed', () => {
  expect(buildNotificationOptions({ source: 'handoff', handoffTitle: 'Review proposal' })).toEqual({
    title: 'New handoff',
    body: 'Review proposal'
  })
})
it('bounds handoff previews and supplies an empty-title fallback', () => {
  expect(
    buildNotificationOptions({ source: 'handoff', handoffTitle: 'a'.repeat(1000) }).body.length
  ).toBeLessThanOrEqual(180)
  expect(buildNotificationOptions({ source: 'handoff', handoffTitle: '' }).body).toBe(
    'Open Needs You to review it.'
  )
})
it('labels an Inbox notification as a message and retains the bounded preview', () => {
  expect(buildNotificationOptions({ source: 'handoff', handoffDestination: 'inbox' })).toEqual({
    title: 'New Inbox message',
    body: 'Open Inbox to read it.'
  })
})
