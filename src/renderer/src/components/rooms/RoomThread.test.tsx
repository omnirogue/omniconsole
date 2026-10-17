// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomThread, roomEventMessage } from './RoomThread'
import { roomEvent, USER, ID } from '../../../../shared/room-test-fixtures'

afterEach(cleanup)
describe('room thread', () => {
  it('preserves sequence order when server timestamps run backwards', () => {
    render(
      <RoomThread
        currentUserId={USER}
        events={[
          roomEvent('1', { content: 'First in sequence', createdAt: '2026-09-13T12:00:02.000Z' }),
          roomEvent('2', {
            eventId: 'a0000000-0000-4000-8000-000000000002',
            content: 'Second in sequence'
          })
        ]}
      />
    )
    const first = screen.getByText('First in sequence'),
      second = screen.getByText('Second in sequence')
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('maps messages into one text block with sender attribution', () => {
    const message = roomEventMessage(roomEvent(), USER)
    expect(message.role).toBe('user')
    expect(message.blocks).toEqual([{ type: 'text', text: '**Sal**\n\nHello' }])
    render(<RoomThread events={[roomEvent()]} currentUserId={USER} />)
    expect(screen.getByText('Sal')).toBeVisible()
    expect(screen.getByText('Hello')).toBeVisible()
  })
  it('renders activity through the existing collapsed tool-run fold', () => {
    const event = roomEvent('2', {
      senderId: ID,
      senderKind: 'bot',
      senderName: 'Research',
      eventKind: 'activity',
      content: 'Private folded step output',
      metadata: { kind: 'tool', toolName: 'Read' }
    })
    render(<RoomThread events={[event]} currentUserId={USER} />)
    expect(screen.getByText('Research')).toBeVisible()
    expect(screen.queryByText('Private folded step output')).not.toBeInTheDocument()
    const button = screen.getAllByRole('button')[0]
    fireEvent.click(button)
    expect(screen.getAllByText('Private folded step output').length).toBeGreaterThan(0)
  })
  it('does not attribute another sender’s activity to preceding prose', () => {
    render(
      <RoomThread
        events={[
          roomEvent('1', { senderName: 'Other person' }),
          roomEvent('2', {
            eventId: 'a0000000-0000-4000-8000-000000000002',
            senderName: 'Agent two',
            eventKind: 'activity'
          })
        ]}
        currentUserId={ID}
      />
    )
    expect(screen.getByText('Other person')).toBeVisible()
    expect(screen.getByText('Agent two')).toBeVisible()
  })
})
