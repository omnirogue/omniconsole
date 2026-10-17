// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BackofficeDiscussions } from './BackofficeDiscussions'

const api = vi.hoisted(() => ({
  projects: vi.fn(),
  rooms: vi.fn(),
  detail: vi.fn(),
  posts: vi.fn()
}))
vi.mock('@/lib/peer-messages', () => ({ peerMessageProjects: api.projects }))
vi.mock('@/lib/peer-rooms', () => ({
  readPeerRooms: api.rooms,
  readPeerRoom: api.detail,
  readPeerRoomMessages: api.posts
}))
const room = {
  id: 'room_a',
  name: 'Existing discussion',
  project_id: 'project_a',
  task_id: 'task_a',
  state: 'open',
  active_members: 1,
  created_at: 1
}
beforeEach(() => {
  vi.resetAllMocks()
  api.projects.mockResolvedValue([{ id: 'project_a', name: 'Project A' }])
  api.rooms.mockResolvedValue({ rooms: [room], next_cursor: null })
  api.detail.mockResolvedValue({
    room_id: room.id,
    room,
    members: [],
    members_truncated: false,
    membership: null
  })
  api.posts.mockResolvedValue({
    posts: [
      {
        id: 'post_a',
        room_id: room.id,
        sender_employee_id: 'emp_author',
        summary: 'Existing message',
        created_at: 1,
        references: [],
        deliveries: [
          {
            id: 'delivery_a',
            recipient_employee_id: 'emp_reader',
            state: 'replied',
            reply: { id: 'reply_a', summary: 'Existing answer', created_at: 2 }
          }
        ]
      }
    ],
    next_cursor: 'post_older'
  })
})
afterEach(cleanup)

it('opens canonical history, displays delivery and reply, loads older posts and opens the original task', async () => {
  const open = vi.fn()
  render(<BackofficeDiscussions onOpenTask={open} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Existing discussion · open' }))
  await screen.findByText('Existing message')
  expect(screen.getByText('Existing answer')).toBeTruthy()
  expect(screen.getByText('emp_reader · replied')).toBeTruthy()
  api.posts.mockResolvedValueOnce({ posts: [], next_cursor: null })
  fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }))
  await waitFor(() => expect(api.posts).toHaveBeenLastCalledWith('room_a', 'post_older'))
  fireEvent.click(screen.getByRole('button', { name: 'Open linked work' }))
  expect(open).toHaveBeenCalledWith('task_a')
})

it('clears content when refreshed project access is refused', async () => {
  render(<BackofficeDiscussions onOpenTask={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Existing discussion · open' }))
  await screen.findByText('Existing message')
  api.projects.mockRejectedValueOnce(new Error('Access revoked'))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh discussions' }))
  await screen.findByRole('alert')
  expect(screen.queryByText('Existing message')).toBeNull()
})

it('does not display a late response from an unmounted account scope', async () => {
  let finish!: (value: unknown) => void
  api.projects.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const view = render(<BackofficeDiscussions key="account_a" onOpenTask={vi.fn()} />)
  api.projects.mockResolvedValueOnce([])
  view.rerender(<BackofficeDiscussions key="account_b" onOpenTask={vi.fn()} />)
  finish([{ id: 'project_a', name: 'Private project A' }])
  await waitFor(() => expect(api.projects).toHaveBeenCalledTimes(2))
  expect(api.rooms).not.toHaveBeenCalled()
})
