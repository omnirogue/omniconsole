// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkPlanComposerDialogProps } from '@/components/work-plan/composer/WorkPlanComposerDialog'
import { CustomStageDialog } from './CustomStageDialog'
import { agentFixture, upNextFixture } from '../up-next-fixture'
import type { UpNextController } from '../use-up-next'

vi.mock('@/components/work-plan/use-work-plan-context', () => ({
  useWorkPlanContext: () => ({ usableAgents: [] })
}))
vi.mock('@/components/session-team/use-session-source-actor', () => ({
  useSessionSourceActor: () => ({ agent: 'claude' })
}))
vi.mock('@/components/work-plan/composer/WorkPlanComposerDialog', () => ({
  WorkPlanComposerDialog: ({ plan, onUse, useError }: WorkPlanComposerDialogProps) => (
    <div>
      {useError && <p role="alert">{useError}</p>}
      <button onClick={() => onUse(plan)}>Use one stage</button>
      <button
        onClick={() =>
          onUse({
            ...plan,
            nodes: [plan.nodes[0]!, { ...plan.nodes[0]!, id: 'another' }, plan.nodes[1]!]
          })
        }
      >
        Use two stages
      </button>
    </div>
  )
}))
afterEach(cleanup)

it('applies a single stage and closes only after the host accepts it', async () => {
  const update = vi.fn(async () => true)
  const onClose = vi.fn()
  render(
    <CustomStageDialog
      block={agentFixture('stage')}
      view={upNextFixture()}
      controller={{ disabled: false, update } as unknown as UpNextController}
      onClose={onClose}
    />
  )
  fireEvent.click(screen.getByText('Use one stage'))
  expect(update).toHaveBeenCalledWith(
    'stage',
    expect.objectContaining({ kind: 'agent', shape: 'solo', n: 1 })
  )
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
})

it('shows the multi-stage refusal without a write or closing the editor', () => {
  const update = vi.fn()
  const onClose = vi.fn()
  render(
    <CustomStageDialog
      block={agentFixture('stage')}
      view={upNextFixture()}
      controller={{ disabled: false, update } as unknown as UpNextController}
      onClose={onClose}
    />
  )
  fireEvent.click(screen.getByText('Use two stages'))
  expect(screen.getByRole('alert').textContent).toBe(
    'The composer engine does not yet support multi-stage patches here.'
  )
  expect(update).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})
