// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ActorFields } from './NextStepActorFields'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/agent/AgentCombobox', () => ({ default: () => null }))
vi.mock('@/components/build-review/BuildReviewAgentFields', () => ({
  BuildReviewModelEffortFields: () => null,
  CatalogModelEffortFields: ({ models }: { models: { id: string }[] }) => (
    <span data-testid="eligible-models">{models.map((model) => model.id).join(',')}</span>
  )
}))
afterEach(cleanup)

it('offers local outcome fallbacks from authenticated host evidence and keeps unavailable saved routes clearable', () => {
  const id = 'openrouter/x-ai/grok-4.5'
  const actor = { agent: 'omp' as const, model: id }
  const model = {
    id,
    label: 'Grok',
    options: [],
    openrouterRouting: 'omp-openrouter-routing-v1' as const
  }
  const agent = { id: 'omp' as const, label: 'OMP', cmd: 'omp', homepageUrl: '', models: [model] }
  const onChange = vi.fn()
  const view = render(
    <ActorFields
      actor={actor}
      agents={[agent]}
      worktreeSelector="folder:work"
      onChange={onChange}
    />
  )
  fireEvent.click(screen.getByText('Model and effort'))
  expect(screen.getByTestId('eligible-models').textContent).toBe(id)
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(onChange).toHaveBeenCalledWith({ ...actor, openrouterCandidates: ['x-ai/grok-4.5'] })
  onChange.mockClear()
  const saved = { ...actor, openrouterCandidates: ['x-ai/grok-4.5'] }
  view.rerender(
    <ActorFields
      actor={saved}
      agents={[{ ...agent, models: [] }]}
      worktreeSelector="folder:work"
      onChange={onChange}
    />
  )
  expect(screen.getByRole('listitem').textContent).toBe('1. x-ai/grok-4.5')
  expect(screen.getByRole('alert').textContent).toContain('execution host has not verified')
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(onChange).toHaveBeenCalledWith({ ...actor, openrouterCandidates: undefined })
})
