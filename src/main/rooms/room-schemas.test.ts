import { describe, expect, it } from 'vitest'
import * as s from './room-schemas'
import { ID, USER, detail, roomEvent } from '../../shared/room-test-fixtures'

describe('room schemas against the service contract', () => {
  it('accepts owner and non-owner agent projections, including older optional fields', () => {
    expect(s.roomDetail.parse(detail).agents[0]).toEqual(detail.agents[0])
    expect(
      s.roomDetail.parse({
        ...detail,
        agents: [{ ...detail.agents[0], repliesUsed: 3, maxReplies: 10 }]
      }).agents[0].repliesUsed
    ).toBe(3)
    expect(
      s.roomDetail.parse({
        ...detail,
        agents: [{ id: ID, ownerId: USER, name: 'Old', available: false }]
      }).agents[0].mode
    ).toBeUndefined()
  })
  it('accepts activity, system and future kinds without losing mentions, targets or usage', () => {
    for (const eventKind of ['activity', 'system', 'future-kind']) {
      const value = roomEvent('2', {
        eventKind,
        metadata: {
          targetAgentIds: [ID],
          kind: 'tool',
          toolName: 'Read',
          usage: { tokensIn: 12, estCostUsd: 0.01 }
        },
        mentionedUserIds: [USER]
      })
      expect(s.roomEvent.parse(value)).toEqual(value)
    }
    expect(s.roomEvent.parse(roomEvent()).turnId).toBeNull()
  })
  it('strips unrecognized server fields rather than passing credentials through', () => {
    expect(s.roomDetail.parse({ ...detail, access_token: 'private' })).not.toHaveProperty(
      'access_token'
    )
  })
  it('enforces bigint sequences and strict send limits', () => {
    expect(s.sequence.parse('9223372036854775807')).toBe('9223372036854775807')
    for (const value of ['9223372036854775808', '-1', '1.1', '01']) {
      expect(s.sequence.safeParse(value).success).toBe(false)
    }
    const body = { eventId: ID, content: '你好', targetAgentIds: [ID], mentionedUserIds: [USER] }
    expect(s.roomSend.parse(body)).toEqual(body)
    for (const change of [
      { targetAgentIds: Array(6).fill(ID) },
      { mentionedUserIds: Array(21).fill(USER) },
      { content: 'x'.repeat(3001) },
      { content: '   ' },
      { origin: 'bad' }
    ]) {
      expect(s.roomSend.safeParse({ ...body, ...change }).success).toBe(false)
    }
  })
  it('preserves pending gating and owner budget state', () => {
    const value = {
      rooms: [
        {
          roomId: ID,
          recipientId: USER,
          consumedSequence: '1',
          headSequence: '9',
          pendingCount: 8,
          mentionCount: 2
        }
      ],
      agents: [
        {
          roomId: ID,
          agentId: ID,
          pendingCount: 1,
          pendingTurns: 1,
          gated: true,
          waitingForBudget: true,
          waitingForConsent: false
        }
      ],
      nextCursor: null
    }
    expect(s.roomPending.parse(value)).toEqual(value)
  })
})
