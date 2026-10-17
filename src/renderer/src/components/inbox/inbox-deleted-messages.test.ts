import { beforeEach, expect, it, vi } from 'vitest'
import { peerMessageProjects, peerMessageThreads } from '@/lib/peer-messages'
import { readDeletedMessages } from './inbox-deleted-messages'
import type { PeerMessageThread } from '../../../../shared/peer-message-contract'

vi.mock('@/lib/peer-messages', () => ({
  peerMessageProjects: vi.fn(),
  peerMessageThreads: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const message = {
  id: 'message_one',
  project_id: 'project_one',
  sender_employee_id: 'emp_other',
  recipient_employee_id: 'emp_me',
  archived: true
} as PeerMessageThread
const page = {
  threads: [message],
  next_cursor: null,
  employee_id: 'emp_me',
  view: 'archived' as const
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(peerMessageProjects).mockResolvedValue([{ id: 'project_one', name: 'Project' }])
  vi.mocked(peerMessageThreads).mockResolvedValue(page)
})

it('loads deleted pages without selecting unread, resolving, or changing delivery', async () => {
  vi.mocked(peerMessageThreads)
    .mockResolvedValueOnce({ ...page, next_cursor: 'next_page' })
    .mockResolvedValueOnce({ ...page, threads: [{ ...message, id: 'message_two' }] })
  expect(await readDeletedMessages('emp_me', 2, () => true)).toEqual({
    messages: [message, { ...message, id: 'message_two' }],
    more: false
  })
  expect(peerMessageThreads).toHaveBeenNthCalledWith(1, 'project_one', undefined, false, 'archived')
  expect(peerMessageThreads).toHaveBeenNthCalledWith(
    2,
    'project_one',
    'next_page',
    false,
    'archived'
  )
})

it.each([
  { employee_id: 'emp_other' },
  { view: undefined },
  { threads: [{ ...message, recipient_employee_id: 'emp_unrelated' }] }
])('rejects an unconfirmed personal deleted view %j', async (patch) => {
  vi.mocked(peerMessageThreads).mockResolvedValue({ ...page, ...patch })
  await expect(readDeletedMessages('emp_me', 1, () => true)).rejects.toThrow('could not confirm')
})

it('exposes pagination rather than silently claiming every message was loaded', async () => {
  vi.mocked(peerMessageThreads).mockResolvedValue({ ...page, next_cursor: 'next_page' })
  expect(await readDeletedMessages('emp_me', 1, () => true)).toMatchObject({ more: true })
  await expect(readDeletedMessages('emp_me', 3, () => true)).rejects.toThrow('fully read')
})

it('stops before the next project when the account changes during a page read', async () => {
  let active = true
  vi.mocked(peerMessageProjects).mockResolvedValue([
    { id: 'one', name: 'One' },
    { id: 'two', name: 'Two' }
  ])
  vi.mocked(peerMessageThreads).mockImplementation(async () => {
    active = false
    return page
  })
  await expect(readDeletedMessages('emp_me', 1, () => active)).rejects.toThrow(
    'confirm your account'
  )
  expect(peerMessageThreads).toHaveBeenCalledTimes(1)
})
