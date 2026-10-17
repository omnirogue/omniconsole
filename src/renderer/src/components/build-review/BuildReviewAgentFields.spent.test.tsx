// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import { CatalogModelEffortFields } from './BuildReviewAgentFields'

vi.mock('@/hooks/useWorkAgentCapabilities', () => ({ useWorkAgentCapabilities: vi.fn() }))
vi.mock('./use-build-review-agent-models', () => ({ useBuildReviewAgentModels: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, args?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(args?.[key] ?? ''))
}))

afterEach(cleanup)

const opus: CatalogModel = { id: 'opus', label: 'Opus', options: [] }
const fable: CatalogModel = { id: 'fable', label: 'Fable 5.1', options: [], isDefault: true }

describe('CatalogModelEffortFields with a spent model', () => {
  it('shows the spent model and "Agent default" as out of usage, and offers neither', async () => {
    const onChange = vi.fn()
    render(
      <CatalogModelEffortFields
        role="builder"
        agent="claude"
        models={[opus]}
        spentModels={[fable]}
        defaultModelSpent
        model="opus"
        effort={undefined}
        onChange={onChange}
      />
    )
    expect(screen.getByLabelText('Model')).toHaveTextContent('Opus')
    fireEvent.click(screen.getByLabelText('Model'))
    const spent = await screen.findByRole('option', { name: 'Fable 5.1 (out of usage)' })
    expect(spent).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('option', { name: 'Agent default (out of usage)' })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
    expect(screen.getByRole('option', { name: 'Opus' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    )
    fireEvent.click(spent)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps "Agent default" offered when nothing is spent', async () => {
    render(
      <CatalogModelEffortFields
        role="builder"
        agent="claude"
        models={[opus, fable]}
        model={undefined}
        effort={undefined}
        onChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByLabelText('Model'))
    expect(await screen.findByRole('option', { name: 'Agent default' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    )
    expect(screen.queryByRole('option', { name: /out of usage/ })).toBeNull()
  })
})
