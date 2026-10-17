// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyLaunchManifest, launchManifestPrompt } from '../../../../shared/launch-manifest'
import { LaunchReviewDialog } from './LaunchReviewDialog'
import { useLaunchReview } from './launch-review-store'

vi.mock('@/components/session-context/SessionContextItemsEditor', () => ({
  SessionContextItemsEditor: () => null
}))

afterEach(() => {
  cleanup()
  useLaunchReview.getState().close()
})

function openReview() {
  const onStart = vi.fn()
  const onClose = vi.fn()
  const manifest = {
    ...emptyLaunchManifest('Fix the checkout'),
    agent: {
      templateId: 'reviewer',
      name: 'Reviewer',
      instructions: 'Use the customer-service policy',
      from: 'project' as const
    },
    attachments: [
      {
        id: 'brief',
        kind: 'instructions' as const,
        title: 'Customer brief',
        content: 'Call clients'
      }
    ],
    sources: { brief: 'project' as const }
  }
  useLaunchReview.getState().open({ manifest, worktreeId: 'folder:work', onStart, onClose })
  render(<LaunchReviewDialog />)
  return { onStart, onClose }
}

it('sends the edited list and records project attachments removed before launch', () => {
  const { onStart, onClose } = openReview()
  fireEvent.click(screen.getByRole('button', { name: 'Leave Customer brief out' }))
  fireEvent.click(screen.getByRole('button', { name: 'Leave Reviewer out' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Task' }), {
    target: { value: 'Fix the local checkout only' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
  expect(onStart).toHaveBeenCalledOnce()
  expect(launchManifestPrompt(onStart.mock.calls[0][0])).toBe('Fix the local checkout only')
  expect(onStart.mock.calls[0][1]).toEqual(['brief'])
  expect(onClose).toHaveBeenCalledOnce()
  expect(useLaunchReview.getState().request).toBeNull()
})

it('cancels without launching and releases the pending review', () => {
  const { onStart, onClose } = openReview()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onStart).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalledOnce()
  expect(useLaunchReview.getState().request).toBeNull()
})
