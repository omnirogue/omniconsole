// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  PromptCostEstimatorBadge,
  type PromptCostEstimatorBadgeProps
} from './PromptCostEstimatorBadge'
import {
  DEFAULT_PROMPT_COST_ESTIMATOR_LABELS,
  estimatePromptCost,
  estimatePromptTokens,
  formatPromptCostUsd,
  type PromptCostEstimatorLabels
} from './prompt-cost-estimator-helpers'

afterEach(cleanup)

const prompt = 'a'.repeat(4_000)
const modelLabel = 'Test model'

function badge(props: PromptCostEstimatorBadgeProps): React.JSX.Element {
  return (
    <TooltipProvider>
      <PromptCostEstimatorBadge {...props} />
    </TooltipProvider>
  )
}

describe('prompt cost estimates', () => {
  it.each(['', ' ', '\n\t'])('treats a blank prompt as empty: %j', (value) => {
    expect(estimatePromptTokens(value)).toBe(0)
  })

  it('rounds up partial tokens and counts multibyte text', () => {
    expect(estimatePromptTokens('hello')).toBe(2)
    expect(estimatePromptTokens('你好')).toBe(2)
    expect(estimatePromptTokens('🙂🙂')).toBe(2)
    expect(estimatePromptTokens('a    ')).toBe(2)
  })

  it('converts a per-million input rate into prompt cost', () => {
    expect(estimatePromptCost(prompt, 2.5)).toEqual({
      inputTokens: 1_000,
      inputCostUsd: 0.0025
    })
    expect(estimatePromptCost(prompt, 0)).toEqual({ inputTokens: 1_000, inputCostUsd: 0 })
  })

  it.each([undefined, null, -1, Number.NaN, Infinity, -Infinity])(
    'preserves unknown cost for missing or invalid pricing: %s',
    (rate) => {
      expect(estimatePromptCost(prompt, rate)).toEqual({
        inputTokens: 1_000,
        inputCostUsd: null
      })
    }
  )

  it('does not present an overflow as a price', () => {
    expect(estimatePromptCost('a'.repeat(4_000_004), Number.MAX_VALUE).inputCostUsd).toBeNull()
  })

  it('keeps sub-cent costs visible and distinguishes zero from a small positive cost', () => {
    expect(formatPromptCostUsd(0)).toBe('$0.00')
    expect(formatPromptCostUsd(0.000001)).toBe('<$0.0001')
    expect(formatPromptCostUsd(0.0001)).toBe('$0.0001')
    expect(formatPromptCostUsd(0.0025)).toBe('$0.0025')
    expect(formatPromptCostUsd(12.5)).toBe('$12.50')
  })

  it('formats prices for the caller’s locale', () => {
    expect(formatPromptCostUsd(1.25, 'de-DE')).toBe(
      new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4
      }).format(1.25)
    )
  })
})

describe('PromptCostEstimatorBadge', () => {
  it('hides blank prompts', () => {
    const { container } = render(badge({ prompt: '\n  ', inputUsdPerMillion: 2.5 }))
    expect(container).toBeEmptyDOMElement()
  })

  it('shows an estimate with keyboard-accessible details and its limits', async () => {
    render(badge({ prompt, inputUsdPerMillion: 2.5, modelLabel }))
    const trigger = screen.getByLabelText(
      'Est. input $0.0025. About 1,000 input tokens. Model: Test model'
    )
    expect(trigger).toHaveAttribute('tabindex', '0')
    expect(trigger).toHaveAttribute('data-prompt-cost-state', 'estimated')
    expect(trigger).toHaveTextContent('Est. input $0.0025')
    fireEvent.focus(trigger)
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('About 1,000 input tokens')
    expect(tooltip).toHaveTextContent('Model: Test model')
    expect(tooltip).toHaveTextContent(DEFAULT_PROMPT_COST_ESTIMATOR_LABELS.description)
  })

  it('updates when prompt text or the selected rate changes, then hides after clearing', () => {
    const { rerender } = render(badge({ prompt, inputUsdPerMillion: 2.5 }))
    rerender(badge({ prompt: prompt.repeat(2), inputUsdPerMillion: 2.5 }))
    expect(screen.getByText('Est. input $0.005')).toBeVisible()
    rerender(badge({ prompt, inputUsdPerMillion: 10 }))
    expect(screen.getByText('Est. input $0.01')).toBeVisible()
    rerender(badge({ prompt: '', inputUsdPerMillion: 10 }))
    expect(screen.queryByText('Est. input $0.01')).not.toBeInTheDocument()
  })

  it('removes a stale price when pricing becomes unavailable', async () => {
    const { rerender } = render(badge({ prompt, inputUsdPerMillion: 2.5 }))
    rerender(badge({ prompt, inputUsdPerMillion: null }))
    expect(screen.queryByText('Est. input $0.0025')).not.toBeInTheDocument()
    const trigger = screen.getByText('Input cost unavailable')
    expect(trigger).toHaveAttribute('data-prompt-cost-state', 'unavailable')
    fireEvent.focus(trigger)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      DEFAULT_PROMPT_COST_ESTIMATOR_LABELS.pricingUnavailable
    )
  })

  it('shows zero-priced input as an estimate', () => {
    render(badge({ prompt, inputUsdPerMillion: 0 }))
    expect(screen.getByText('Est. input $0.00')).toHaveAttribute(
      'data-prompt-cost-state',
      'estimated'
    )
  })

  it('accepts localized labels for every visible and accessible message', async () => {
    const labels: PromptCostEstimatorLabels = {
      estimatedCost: (cost) => `Entrada ${cost}`,
      estimatedTokens: (tokens) => `Unos ${tokens} tokens`,
      model: (name) => `Modelo: ${name}`,
      unavailable: 'Precio no disponible',
      description: 'Solo texto; el uso real puede variar.',
      pricingUnavailable: 'Falta la tarifa del modelo.'
    }
    const props = { prompt, modelLabel, labels, locale: 'de-DE', className: 'test-badge' }
    const { rerender } = render(badge({ ...props, inputUsdPerMillion: 2.5 }))
    // Why: de-DE currency uses a no-break space; Testing Library normalizes the
    // DOM label to plain spaces but compares the expected string as given.
    const trigger = screen.getByLabelText(
      `Entrada ${formatPromptCostUsd(0.0025, 'de-DE')}. Unos 1.000 tokens. Modelo: Test model`.replace(/\s+/g, ' ')
    )
    expect(trigger).toHaveClass('test-badge')
    fireEvent.focus(trigger)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(labels.description)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Modelo: Test model')
    rerender(badge({ ...props, inputUsdPerMillion: null }))
    expect(screen.getByText(labels.unavailable)).toBeVisible()
    expect(screen.getByRole('tooltip')).toHaveTextContent(labels.pricingUnavailable)
    expect(document.body).not.toHaveTextContent(DEFAULT_PROMPT_COST_ESTIMATOR_LABELS.unavailable)
  })
})
