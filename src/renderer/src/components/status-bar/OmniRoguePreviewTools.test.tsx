// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OmniRoguePreviewToolPanels } from './OmniRoguePreviewTools'
import { sessionSpendGuardLimits } from './omnirogue-session-spend-guard'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string) => english
}))

afterEach(cleanup)

describe('sessionSpendGuardLimits', () => {
  it('turns budgeted sessions into session limits and skips unbudgeted ones', () => {
    const base = { requestCount: 1, updatedAt: 1, reservedCredits: 5 }
    expect(
      sessionSpendGuardLimits([
        { ...base, sessionId: 'a', spentCredits: 40, budgetCredits: 50 },
        { ...base, sessionId: 'b', spentCredits: 10, budgetCredits: null }
      ])
    ).toEqual([{ period: 'session', limitCredits: 50, spentCredits: 45 }])
  })
})

describe('OmniRoguePreviewToolPanels', () => {
  it('opens Brand Kits and reports that its service is not live', async () => {
    render(<OmniRoguePreviewToolPanels tool="brandKits" onClose={vi.fn()} />)
    expect(await screen.findByText('Could not load brand kits. Try again.')).toBeInTheDocument()
  })

  it('opens the asset inspector with nothing selected', () => {
    render(<OmniRoguePreviewToolPanels tool="assets" onClose={vi.fn()} />)
    expect(screen.getByText('Select a generated asset to inspect it.')).toBeInTheDocument()
  })

  it('renders no panel when no tool is chosen', () => {
    render(<OmniRoguePreviewToolPanels tool={null} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
