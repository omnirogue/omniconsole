// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import { CatalogModelEffortFields } from './BuildReviewAgentFields'

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(() => {
    throw new Error('Supplied catalogs must not discover workspace capabilities')
  }),
  discoverModels: vi.fn(() => {
    throw new Error('Supplied catalogs must not discover workspace models')
  })
}))

vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: mocks.capabilities
}))
vi.mock('./use-build-review-agent-models', () => ({
  useBuildReviewAgentModels: mocks.discoverModels
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))

const models: CatalogModel[] = [
  {
    id: 'remote-review-model',
    label: 'Remote reviewer',
    isDefault: true,
    options: [
      {
        id: 'effort',
        label: 'Effort',
        kind: {
          type: 'select',
          choices: [
            { value: 'quick', label: 'Remote quick' },
            { value: 'thorough', label: 'Remote thorough' }
          ],
          defaultValue: 'quick'
        },
        apply: {}
      }
    ]
  },
  {
    id: 'remote-small-model',
    label: 'Remote small',
    options: [
      {
        id: 'effort',
        label: 'Effort',
        kind: {
          type: 'select',
          choices: [{ value: 'quick', label: 'Remote quick' }],
          defaultValue: 'quick'
        },
        apply: {}
      }
    ]
  }
]

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('CatalogModelEffortFields', () => {
  it('uses the supplied model and effort menus without probing the workspace', async () => {
    const onChange = vi.fn()
    render(
      <CatalogModelEffortFields
        role="remote-reviewer"
        agent="codex"
        models={models}
        model="remote-review-model"
        effort="quick"
        defaultLabel="Remote default"
        onChange={onChange}
      />
    )

    expect(screen.getByLabelText('Model')).toHaveTextContent('Remote reviewer')
    expect(screen.getByLabelText('Effort')).toHaveTextContent('Remote quick')
    fireEvent.click(screen.getByLabelText('Effort'))
    await screen.findByRole('option', { name: 'Remote thorough' })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Remote default',
      'Remote quick',
      'Remote thorough'
    ])
    fireEvent.click(screen.getByRole('option', { name: 'Remote thorough' }))
    expect(onChange).toHaveBeenLastCalledWith({
      model: 'remote-review-model',
      effort: 'thorough'
    })

    fireEvent.click(screen.getByLabelText('Model'))
    await screen.findByRole('option', { name: 'Remote small' })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Remote default',
      'Remote reviewer',
      'Remote small'
    ])
    expect(mocks.capabilities).not.toHaveBeenCalled()
    expect(mocks.discoverModels).not.toHaveBeenCalled()
  })

  it.each([
    ['thorough', { model: 'remote-small-model' }],
    ['quick', { model: 'remote-small-model', effort: 'quick' }]
  ] as const)(
    'keeps effort %s only when the newly selected model supports it',
    async (effort, choice) => {
      const onChange = vi.fn()
      render(
        <CatalogModelEffortFields
          role="remote-reviewer"
          agent="codex"
          models={models}
          model="remote-review-model"
          effort={effort}
          onChange={onChange}
        />
      )

      fireEvent.click(screen.getByLabelText('Model'))
      fireEvent.click(await screen.findByRole('option', { name: 'Remote small' }))
      expect(onChange).toHaveBeenCalledWith(choice)
    }
  )

  it.each(['gpt-5.5', undefined])(
    'does not infer effort from static presets when the supplied model %s has no options',
    (model) => {
      render(
        <CatalogModelEffortFields
          role="remote-reviewer"
          agent="codex"
          models={[{ id: 'gpt-5.5', label: 'Remote model', options: [], isDefault: true }]}
          model={model}
          effort="high"
          onChange={vi.fn()}
        />
      )

      expect(screen.getByLabelText('Model')).toBeInTheDocument()
      expect(screen.queryByLabelText('Effort')).not.toBeInTheDocument()
    }
  )

  it('does not offer static model or effort menus when the supplied catalog is empty', () => {
    render(
      <CatalogModelEffortFields
        role="remote-reviewer"
        agent="codex"
        models={[]}
        model="gpt-5.5"
        effort="high"
        onChange={vi.fn()}
      />
    )

    expect(screen.getByText('No verified models available.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Effort')).not.toBeInTheDocument()
  })
})
