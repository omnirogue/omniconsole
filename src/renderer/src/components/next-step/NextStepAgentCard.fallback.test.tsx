// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import type { NextStepAgentRecipient } from '../../../../shared/next-step-draft'
import { NextStepAgentCard } from './NextStepAgentCard'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))
vi.mock('./recipient-avatar', () => ({ RecipientAvatar: () => null }))
vi.mock('./next-step-summary', () => ({
  actionLabel: (id: string) => id,
  describeNextStepAgent: () => '',
  nextStepAgentName: () => 'OMP'
}))
vi.mock('@/components/agent/AgentAccountSelect', () => ({ AgentAccountSelect: () => null }))
vi.mock('@/components/build-review/BuildReviewAgentFields', () => ({
  BuildReviewModelEffortFields: () => null,
  CatalogModelEffortFields: ({
    model,
    preserveUnavailable,
    onChange
  }: {
    model?: string
    preserveUnavailable?: boolean
    onChange: (next: { model?: string }) => void
  }) => (
    <div>
      <span data-testid="primary" data-preserved={preserveUnavailable}>
        {model}
      </span>
      <button type="button" onClick={() => onChange({ model: 'openrouter/moonshotai/kimi-k2.5' })}>
        Select Kimi
      </button>
    </div>
  )
}))
const primary = 'x-ai/grok-4.5'
const kimi = 'moonshotai/kimi-k2.5'
const initial: NextStepAgentRecipient = {
  kind: 'agent',
  key: 'actor',
  agent: 'omp',
  presetId: 'implement',
  instructions: 'Work',
  rounds: 1,
  model: `openrouter/${primary}`,
  openrouterCandidates: [primary, kimi]
}
const models: CatalogModel[] = [primary, kimi].map((id) => ({
  id: `openrouter/${id}`,
  label: id,
  options: [],
  hosts: ['first']
}))
afterEach(cleanup)
function Editor({ host, offered = models }: { host: string; offered?: CatalogModel[] }) {
  const [recipient, setRecipient] = useState(initial)
  return (
    <NextStepAgentCard
      recipient={recipient}
      worktreeSelector={null}
      models={offered}
      fleetMachineId={host}
      roundsAllowed
      problem={false}
      onChange={setRecipient}
    />
  )
}

describe('fallback editor mounted in the agent card', () => {
  it('keeps reviewed candidates after changing primary until the operator repairs the order', () => {
    render(<Editor host="first" />)
    fireEvent.click(screen.getByText('Model and effort'))
    fireEvent.click(screen.getByRole('button', { name: 'Select Kimi' }))
    expect(screen.getByTestId('primary').textContent).toBe(`openrouter/${kimi}`)
    expect(screen.getByTestId('primary').getAttribute('data-preserved')).toBe('true')
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `1. ${primary}`,
      `2. ${kimi}`
    ])
    expect(screen.getByRole('alert').textContent).toContain('selected model first')
    fireEvent.click(screen.getByRole('button', { name: 'Use selected model first' }))
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `1. ${kimi}`,
      `2. ${primary}`
    ])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retains exact saved choices across host/catalog changes with actionable refusal', () => {
    const view = render(<Editor host="first" />)
    view.rerender(<Editor host="second" offered={[]} />)
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `1. ${primary}`,
      `2. ${kimi}`
    ])
    expect(screen.getByRole('alert').textContent).toContain('refresh host inventory')
    view.rerender(<Editor host="first" />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `1. ${primary}`,
      `2. ${kimi}`
    ])
  })
})

it('enables local editing only for host-attested models and preserves the route after evidence is revoked', () => {
  const localModels = models.map((model) => ({
    ...model,
    openrouterRouting: 'omp-openrouter-routing-v1' as const
  }))
  const onChange = vi.fn()
  const props = {
    recipient: initial,
    worktreeSelector: null,
    roundsAllowed: true,
    problem: false,
    onChange
  }
  const view = render(<NextStepAgentCard {...props} localModels={localModels} />)
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(onChange).toHaveBeenCalledWith({ ...initial, openrouterCandidates: undefined })
  onChange.mockClear()
  view.rerender(<NextStepAgentCard {...props} localModels={models} />)
  expect(screen.getByRole('alert').textContent).toContain('execution host has not verified')
  expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
    `1. ${primary}`,
    `2. ${kimi}`
  ])
  expect(onChange).not.toHaveBeenCalled()
})
