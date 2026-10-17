// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { createSessionTaskStore } from './session-task-store'
vi.mock('@/store', () => ({ useAppStore: vi.fn() }))
it('loads other saved conversations before attaching or clearing an uncached session', () => {
  const saved = { other: { taskId: 'btk_existing', title: 'Existing cached link' } }
  const save = vi.fn()
  const store = createSessionTaskStore({ load: () => saved, save })
  store.getState().link('taskless', null)
  expect(store.getState().loaded).toBe(true)
  expect(store.getState().links).toEqual(saved)
  expect(save).not.toHaveBeenCalled()
  store.getState().link('new', { taskId: 'btk_another' })
  expect(save).toHaveBeenCalledWith({ ...saved, new: { taskId: 'btk_another' } })
})
