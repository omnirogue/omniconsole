// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoomsApi } from '../../../../shared/rooms'
import { ID, detail, roomEvent } from '../../../../shared/room-test-fixtures'
import { RoomConversation } from './RoomConversation'

afterEach(cleanup)
describe('room visibility and explicit read receipts', () => {
  it('only acknowledges after Mark read and stops watching on unmount', async () => {
    const ack = vi.fn().mockResolvedValue({ ok: true, data: { consumedSequence: '7' } })
    const setWatchedRoom = vi.fn().mockResolvedValue({
      ok: true,
      data: { events: [roomEvent('7')], sequence: '7', gaps: [], retryMs: 2000 }
    })
    const unsubscribe = vi.fn(),
      onRead = vi.fn()
    const api = {
      getRoom: vi.fn().mockResolvedValue({ ok: true, data: detail }),
      setWatchedRoom,
      ack,
      onSnapshot: vi.fn().mockReturnValue(unsubscribe)
    } as unknown as RoomsApi
    const view = render(<RoomConversation api={api} id={ID} onRead={onRead} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark read' })).not.toBeDisabled()
    )
    expect(ack).not.toHaveBeenCalled()
    expect(setWatchedRoom).toHaveBeenCalledWith(ID)
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }))
    await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1))
    expect(ack).toHaveBeenCalledWith(ID, '7')
    view.unmount()
    expect(setWatchedRoom).toHaveBeenLastCalledWith(null)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
