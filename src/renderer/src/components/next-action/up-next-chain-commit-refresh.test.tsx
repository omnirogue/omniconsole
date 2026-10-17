// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UpNextChain } from './UpNextChain'
import { upNextFixture } from './up-next-fixture'

const commit = vi.hoisted(() => vi.fn())
vi.mock('./use-up-next', () => ({
  useUpNext: () => ({
    view: {
      ...upNextFixture('busy'),
      draftCount: 1,
      blocks: [
        {
          id: 'draft:prompt',
          kind: 'prompt',
          state: 'draft',
          number: '1',
          locked: false,
          text: 'Check the result',
          target: { kind: 'current' },
          when: 'after'
        }
      ]
    },
    error: null,
    disabled: false,
    commit,
    append: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(),
    remove: vi.fn(),
    discardDrafts: vi.fn(),
    configureAfter: vi.fn()
  })
}))
vi.mock('./up-next-surface', () => ({ upNextSurface: () => ({}) }))
afterEach(cleanup)
it.each([true, false])(
  'advances a bulk session only after a confirmed composer commit (%s)',
  async (accepted) => {
    commit.mockResolvedValue(accepted)
    const onChanged = vi.fn()
    render(
      <UpNextChain
        source={{ kind: 'pty', worktreeId: 'folder', paneKey: 'tab:pane' }}
        onChanged={onChanged}
      />
    )
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Queue 1 new block' }))
    )
    expect(onChanged).toHaveBeenCalledTimes(accepted ? 1 : 0)
  }
)
