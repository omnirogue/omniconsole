import { expect, it, vi } from 'vitest'
import { collectTodoPages, type TodoFeed } from './backoffice-work-pages'
import { BackofficeNotModified } from '@/lib/backoffice-not-modified'

it('304 leaves the complete todo snapshot alone without following its cursor', async () => {
  const previous = { items: [{ task_id: 'btk_a' }], nextCursor: 'page_2' } as TodoFeed
  const read = vi.fn().mockResolvedValue({ ...previous, notModified: true })
  await expect(collectTodoPages(read, { previous })).rejects.toBeInstanceOf(BackofficeNotModified)
  expect(read).toHaveBeenCalledTimes(1)
  expect(previous.items).toEqual([{ task_id: 'btk_a' }])
})
