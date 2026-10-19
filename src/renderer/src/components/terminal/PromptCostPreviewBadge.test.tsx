// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PromptCostPreviewBadge } from './PromptCostPreviewBadge'

const state = { settings: { experimentalOmniSiPreviews: false } }
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))

afterEach(cleanup)

function renderBadge(prompt: string) {
  return render(
    <TooltipProvider>
      <PromptCostPreviewBadge prompt={prompt} />
    </TooltipProvider>
  )
}

describe('PromptCostPreviewBadge', () => {
  it('stays hidden while OmniSI previews are off', () => {
    state.settings.experimentalOmniSiPreviews = false
    renderBadge('Refactor the checkout retry loop')
    expect(document.querySelector('[data-prompt-cost-state]')).toBeNull()
  })

  it('estimates the draft and marks the cost unavailable without a model rate', () => {
    state.settings.experimentalOmniSiPreviews = true
    renderBadge('Refactor the checkout retry loop')
    const badge = document.querySelector('[data-prompt-cost-state]')
    expect(badge?.getAttribute('data-prompt-cost-state')).toBe('unavailable')
    expect(screen.getByText('Input cost unavailable')).toBeTruthy()
  })
})
