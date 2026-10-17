// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { NextStepOutcomeSurface } from './NextStepOutcomeSurface'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
afterEach(cleanup)

const zIndexClass = (element: Element): string | undefined =>
  element.className.split(/\s+/).find((token) => token.startsWith('z-'))

it('sits at the dialog tier so a dialog opened from inside stacks above it', () => {
  render(
    <Popover open>
      <PopoverAnchor asChild>
        <button type="button">Next</button>
      </PopoverAnchor>
      <NextStepOutcomeSurface open presentation="popover" onOpenChange={() => {}}>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Create task</DialogTitle>
          </DialogContent>
        </Dialog>
      </NextStepOutcomeSurface>
    </Popover>
  )
  const surface = document.querySelector('[data-slot="popover-content"]')!
  const overlay = document.querySelector('[data-slot="dialog-overlay"]')!
  const dialog = screen.getByRole('dialog', { name: 'Create task' })
  // Why: an ordinary popover is z-[60], above dialogs; this surface gives that up on purpose.
  expect(zIndexClass(surface)).toBe('z-50')
  expect(zIndexClass(overlay)).toBe('z-50')
  expect(zIndexClass(dialog)).toBe('z-50')
  expect(surface.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(surface.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('renders nothing inside the popover while closed', () => {
  render(
    <Popover open>
      <PopoverAnchor asChild>
        <button type="button">Next</button>
      </PopoverAnchor>
      <NextStepOutcomeSurface open={false} presentation="popover" onOpenChange={() => {}}>
        <p>Body</p>
      </NextStepOutcomeSurface>
    </Popover>
  )
  expect(screen.queryByText('Body')).toBeNull()
})
