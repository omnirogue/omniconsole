import { expect, it } from 'vitest'
import { decodeRoomRecord, encodeRoomRecord, ROOM_RECORD_PREFIX } from './inbox-room-record'
const record = {
  kind: 'recap' as const,
  title: 'Review',
  body: 'Evidence remains incomplete.',
  source_message_ids: ['post_one'],
  open_questions: ['Did the test run?']
}
it('round-trips a durable record without upgrading proposals to approval', () => {
  expect(decodeRoomRecord(encodeRoomRecord(record))).toEqual(record)
  expect(
    decodeRoomRecord(ROOM_RECORD_PREFIX + JSON.stringify({ ...record, kind: 'approved_decision' }))
  ).toBeNull()
})
it('treats unknown versions and malformed or extra fields as ordinary text', () => {
  expect(decodeRoomRecord('Ordinary message')).toBeNull()
  expect(decodeRoomRecord(`${ROOM_RECORD_PREFIX}{broken`)).toBeNull()
  expect(
    decodeRoomRecord(ROOM_RECORD_PREFIX + JSON.stringify({ ...record, execute: true }))
  ).toBeNull()
})
it('enforces the transport byte bound and canonical task references', () => {
  expect(() => encodeRoomRecord({ ...record, body: '界'.repeat(700) })).toThrow('limit')
  expect(() => encodeRoomRecord({ ...record, task_id: 'dcn_wrong' })).toThrow()
})

it('reads the live server response after whitespace normalization', () => {
  const sent = encodeRoomRecord(record)
  const received = sent.replace(/\s+/g, ' ')
  expect(decodeRoomRecord(received)).toEqual(record)
})
