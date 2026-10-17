// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuildReviewAgentFields } from './BuildReviewAgentFields'
const mocks = vi.hoisted(() => ({ capabilities: vi.fn(() => ({ usable: [] })) }))
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: mocks.capabilities
}))
vi.mock('./use-build-review-agent-models', () => ({ useBuildReviewAgentModels: () => [] }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
afterEach(() => {
  cleanup()
  mocks.capabilities.mockClear()
})

describe('reviewer field capability mode', () => {
  it.each(['workspace-launch', 'task-continuation'] as const)(
    'uses %s for both agent and model fields',
    (mode) => {
      render(
        <BuildReviewAgentFields
          role="reviewer"
          label="Reviewer"
          worktree="id:folder:linked"
          choice={{ agent: 'codex' }}
          capabilityMode={mode}
          onChange={vi.fn()}
        />
      )
      expect(mocks.capabilities).toHaveBeenCalledTimes(2)
      for (const args of mocks.capabilities.mock.calls) {
        expect(args).toEqual(['folder:linked', undefined, mode])
      }
    }
  )
})

describe('the Build + Review setup row', () => {
  it('keeps an agent whose usage is unchecked selectable and says so quietly', () => {
    mocks.capabilities.mockReturnValue({
      usable: [{ id: 'codex', models: [], usageUnchecked: true }]
    } as never)
    try {
      const view = render(
        <BuildReviewAgentFields
          role="builder"
          label="Builder"
          worktree="id:folder:linked"
          choice={{ agent: 'codex' }}
          capabilityMode="build-review"
          appearance="row"
          helpText={null}
          onChange={vi.fn()}
        />
      )
      expect(view.getByText('Usage not checked yet.')).toBeTruthy()
      // A quiet labelled row, not a framed fieldset.
      expect(view.getByRole('group', { name: 'Builder' })).toBeTruthy()
      expect(view.container.querySelector('fieldset')).toBeNull()
      expect(
        mocks.capabilities.mock.calls.every((args) => (args as unknown[])[2] === 'build-review')
      ).toBe(true)
    } finally {
      mocks.capabilities.mockReturnValue({ usable: [] })
    }
  })

  it('says nothing about usage when the reading is current', () => {
    mocks.capabilities.mockReturnValue({ usable: [{ id: 'codex', models: [] }] } as never)
    try {
      const view = render(
        <BuildReviewAgentFields
          role="builder"
          label="Builder"
          worktree="id:folder:linked"
          choice={{ agent: 'codex' }}
          onChange={vi.fn()}
        />
      )
      expect(view.queryByText('Usage not checked yet.')).toBeNull()
      expect(view.container.querySelector('fieldset legend')?.textContent).toBe('Builder')
    } finally {
      mocks.capabilities.mockReturnValue({ usable: [] })
    }
  })
})
