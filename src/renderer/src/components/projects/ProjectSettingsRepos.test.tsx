// @vitest-environment happy-dom
import { Suspense } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { AddRepoDialogHostedController } from '@/components/sidebar/use-add-repo-hosted-controller'

const mocks = vi.hoisted(() => ({
  repos: [] as Repo[],
  hosted: null as AddRepoDialogHostedController | null,
  toastWarning: vi.fn(),
  closeProjectSettings: vi.fn()
}))
vi.mock('@/store', () => {
  const state = () => ({ repos: mocks.repos })
  const useAppStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state())
  useAppStore.getState = state
  return { useAppStore }
})
vi.mock('sonner', () => ({ toast: { warning: mocks.toastWarning } }))
vi.mock('./project-settings-dialog-store', () => ({
  closeProjectSettings: mocks.closeProjectSettings
}))
vi.mock('@/components/sidebar/AddRepoDialog', () => ({
  default: ({ hosted }: { hosted: AddRepoDialogHostedController }) => {
    mocks.hosted = hosted
    return hosted.open ? <div data-testid="add-repo-dialog" /> : null
  }
}))
import {
  newlyRegisteredRepos,
  orderProjectRepoChoices,
  ProjectSettingsRepos
} from './ProjectSettingsRepos'

const repo = (id: string, displayName: string, canonicalKey: string | null): Repo =>
  ({
    id,
    displayName,
    path: `/work/${displayName}`,
    gitRemoteIdentity: canonicalKey
      ? { canonicalKey, remoteName: 'origin', remoteUrl: `https://${canonicalKey}.git` }
      : null
  }) as unknown as Repo

const fourRepos = () => [
  repo('1', 'web', 'github.com/acme/web'),
  repo('2', 'api', 'github.com/acme/api'),
  repo('3', 'ads', 'github.com/omnirogue/adsmanager'),
  repo('4', 'docs', 'github.com/acme/docs')
]

const rowLabels = () =>
  screen.getAllByRole('listitem').map((item) => item.querySelector('span.font-medium')?.textContent)

/** Opens the hosted add dialog, registers `added` in the store, and closes it as the dialog does. */
async function addThroughDialog(added: Repo[]): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Add repo…' }))
  await screen.findByTestId('add-repo-dialog')
  mocks.repos = [...mocks.repos, ...added]
  await act(async () => {
    mocks.hosted!.onOpenChange(false)
    await mocks.hosted!.onProjectAdded(added[0]?.id ?? '')
  })
}

afterEach(() => {
  cleanup()
  mocks.repos = []
  mocks.hosted = null
  mocks.toastWarning.mockClear()
  mocks.closeProjectSettings.mockClear()
})

describe('orderProjectRepoChoices', () => {
  it('lists pinned repos first, then ones with a remote, then by name', () => {
    const rows = [
      { gitIdentity: 'path:/w/local', label: 'zeta-local', hasRemote: false },
      { gitIdentity: 'github.com/acme/web', label: 'web', hasRemote: true },
      { gitIdentity: 'github.com/acme/api', label: 'api', hasRemote: true },
      { gitIdentity: 'github.com/acme/ads', label: 'Ads', hasRemote: true }
    ]
    const ordered = orderProjectRepoChoices(rows, new Set(['github.com/acme/web']))
    expect(ordered.map((row) => row.label)).toEqual(['web', 'Ads', 'api', 'zeta-local'])
  })
})

describe('newlyRegisteredRepos', () => {
  it('splits repos registered since the snapshot by whether they have a remote', () => {
    const before = new Set(['1'])
    const now = [
      repo('1', 'web', 'github.com/acme/web'),
      repo('2', 'api', 'github.com/acme/api'),
      repo('3', 'api-copy', 'github.com/acme/api'),
      repo('4', 'scratch', null)
    ]
    expect(newlyRegisteredRepos(before, now)).toEqual({
      identities: ['github.com/acme/api'],
      withoutRemote: ['scratch']
    })
  })
})

describe('ProjectSettingsRepos', () => {
  it('filters the list by name or remote identity once it is long', () => {
    mocks.repos = fourRepos()
    render(<ProjectSettingsRepos repos={[]} onChange={vi.fn()} />)
    const search = screen.getByRole('textbox', { name: 'Search repos…' })
    fireEvent.change(search, { target: { value: 'omnirogue' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('ads')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'nothing-here' } })
    expect(screen.getByText('No repos match “nothing-here”.')).toBeTruthy()
  })

  it('hides the search while the list is short', () => {
    mocks.repos = [repo('1', 'web', 'github.com/acme/web')]
    render(<ProjectSettingsRepos repos={[]} onChange={vi.fn()} />)
    expect(screen.queryByRole('textbox', { name: 'Search repos…' })).toBeNull()
  })

  it('keeps a row in place when its box is ticked', () => {
    mocks.repos = fourRepos()
    const onChange = vi.fn()
    const { rerender } = render(<ProjectSettingsRepos repos={[]} onChange={onChange} />)
    expect(rowLabels()).toEqual(['ads', 'api', 'docs', 'web'])
    fireEvent.click(screen.getAllByRole('checkbox')[2]!)
    expect(onChange).toHaveBeenCalledWith([{ gitIdentity: 'github.com/acme/docs' }])
    rerender(
      <ProjectSettingsRepos repos={[{ gitIdentity: 'github.com/acme/docs' }]} onChange={onChange} />
    )
    expect(rowLabels()).toEqual(['ads', 'api', 'docs', 'web'])
    expect(screen.getByText('1 chosen')).toBeTruthy()
  })

  it('ticks every repo the add dialog registered, pins them first and clears the search', async () => {
    mocks.repos = fourRepos()
    const onChange = vi.fn()
    const { rerender } = render(<ProjectSettingsRepos repos={[]} onChange={onChange} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search repos…' }), {
      target: { value: 'web' }
    })
    await addThroughDialog([
      repo('9', 'omnirogue', 'github.com/omnirogue/omnirogue'),
      repo('10', 'omni-ide', 'github.com/omnirogue/omni-ide')
    ])
    const picked = [
      { gitIdentity: 'github.com/omnirogue/omnirogue' },
      { gitIdentity: 'github.com/omnirogue/omni-ide' }
    ]
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(picked)
    expect(mocks.toastWarning).not.toHaveBeenCalled()
    expect(screen.queryByTestId('add-repo-dialog')).toBeNull()
    rerender(<ProjectSettingsRepos repos={picked} onChange={onChange} />)
    expect((screen.getByRole('textbox', { name: 'Search repos…' }) as HTMLInputElement).value).toBe(
      ''
    )
    expect(rowLabels().slice(0, 2)).toEqual(['omni-ide', 'omnirogue'])
  })

  it('does not re-add a repo the project already holds', async () => {
    const held = [{ gitIdentity: 'github.com/omnirogue/omnirogue' }]
    const onChange = vi.fn()
    render(<ProjectSettingsRepos repos={held} onChange={onChange} />)
    await addThroughDialog([repo('9', 'omnirogue', 'github.com/omnirogue/omnirogue')])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('absorbs additions with the latest committed picks and callback', async () => {
    const originalOnChange = vi.fn()
    const currentOnChange = vi.fn()
    const { rerender } = render(<ProjectSettingsRepos repos={[]} onChange={originalOnChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add repo…' }))
    await screen.findByTestId('add-repo-dialog')
    const controller = mocks.hosted!
    const held = [{ gitIdentity: 'github.com/acme/web' }]
    rerender(<ProjectSettingsRepos repos={held} onChange={currentOnChange} />)
    mocks.repos = [repo('9', 'api', 'github.com/acme/api')]
    await act(async () => controller.onOpenChange(false))
    expect(originalOnChange).not.toHaveBeenCalled()
    expect(currentOnChange).toHaveBeenCalledWith([...held, { gitIdentity: 'github.com/acme/api' }])
  })

  it('does not absorb additions into props from a suspended render', async () => {
    const committedOnChange = vi.fn()
    const uncommittedOnChange = vi.fn()
    const pending = new Promise<void>(() => {})
    function Suspend({ active }: { active: boolean }): null {
      if (active) {
        throw pending
      }
      return null
    }
    const view = (suspended: boolean) => (
      <Suspense fallback={<span>Loading</span>}>
        <ProjectSettingsRepos
          repos={suspended ? [{ gitIdentity: 'github.com/acme/uncommitted' }] : []}
          onChange={suspended ? uncommittedOnChange : committedOnChange}
        />
        <Suspend active={suspended} />
      </Suspense>
    )
    const { rerender } = render(view(false))
    fireEvent.click(screen.getByRole('button', { name: 'Add repo…' }))
    await screen.findByTestId('add-repo-dialog')
    const controller = mocks.hosted!
    rerender(view(true))
    mocks.repos = [repo('9', 'api', 'github.com/acme/api')]
    await act(async () => controller.onOpenChange(false))
    expect(uncommittedOnChange).not.toHaveBeenCalled()
    expect(committedOnChange).toHaveBeenCalledWith([{ gitIdentity: 'github.com/acme/api' }])
  })

  it('explains an added repo that has no remote instead of ticking it', async () => {
    const onChange = vi.fn()
    render(<ProjectSettingsRepos repos={[]} onChange={onChange} />)
    await addThroughDialog([repo('7', 'scratch', null)])
    expect(onChange).not.toHaveBeenCalled()
    expect(mocks.toastWarning).toHaveBeenCalledTimes(1)
    expect(mocks.toastWarning.mock.calls[0]![0]).toContain('scratch')
  })

  it('lets a navigating outcome close the project dialog through closeHost', async () => {
    render(<ProjectSettingsRepos repos={[]} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add repo…' }))
    await screen.findByTestId('add-repo-dialog')
    mocks.hosted!.closeHost!()
    expect(mocks.closeProjectSettings).toHaveBeenCalledTimes(1)
  })

  it('keeps a repo saved on another computer and shows the count', () => {
    render(
      <ProjectSettingsRepos
        repos={[{ gitIdentity: 'github.com/acme/elsewhere' }]}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByText('1 chosen')).toBeTruthy()
    expect(screen.getAllByText('github.com/acme/elsewhere')).toHaveLength(2)
  })
})
