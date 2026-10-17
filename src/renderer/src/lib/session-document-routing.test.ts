import { expect, it, vi } from 'vitest'
import {
  captureSessionFileOpener,
  registerSessionDocumentRouting,
  tryOpenSessionDocument
} from './session-document-routing'

it('does not open a file in a different session after an asynchronous host read', () => {
  const old = vi.fn(() => true)
  const disposeOld = registerSessionDocumentRouting(() => true, old)
  const captured = captureSessionFileOpener()
  const current = vi.fn(() => true)
  const disposeCurrent = registerSessionDocumentRouting(() => true, current)
  disposeOld()
  expect(
    captured('/work/plan.md', { settings: null, worktreeId: 'w', worktreePath: '/work' })
  ).toBe(false)
  expect(old).not.toHaveBeenCalled()
  expect(current).not.toHaveBeenCalled()
  expect(tryOpenSessionDocument('https://example.test')).toBe(true)
  disposeCurrent()
  expect(tryOpenSessionDocument('https://example.test')).toBe(false)
})
