// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NextStepHandoffOptions } from '../../../../shared/next-step-draft'
import { useSessionPlaces } from '@/store/session-place-store'
import type { NextStepOutcomeFacts } from './next-step-outcome-facts'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/lib/company-folder-home', () => ({ getCompanyFolderHome: async () => '/Users/maintainer' }))
vi.mock('./NextStepFolderPickButton', () => ({
  NextStepFolderPickButton: ({ onPick }: { onPick: (path: string) => void }) => (
    <button type="button" onClick={() => onPick('/picked/folder')}>
      Choose folder…
    </button>
  )
}))
import { NextStepOutcomeFiles } from './NextStepOutcomeFiles'
afterEach(cleanup)
beforeEach(() => useSessionPlaces.setState({ places: {}, recentFolders: [], loaded: true }))

const facts = (hostId: 'local' | 'ssh:box' = 'local'): NextStepOutcomeFacts => ({
  session: { worktreeId: 'folder:work', hostId, paneKey: 'tab:pane', label: 'Work' } as never,
  workspacePath: '/Users/maintainer/Work/site',
  branch: 'main',
  repoId: 'repo',
  repoName: 'site',
  model: null,
  summary: null,
  task: null,
  defaultDeliverables: null
})

function Harness({ hostId }: { hostId?: 'local' | 'ssh:box' }) {
  const [handoff, setHandoff] = useState<NextStepHandoffOptions>({
    task: null,
    deliverables: null,
    includeSummary: true
  })
  return (
    <>
      <NextStepOutcomeFiles
        facts={facts(hostId)}
        handoff={handoff}
        onHandoffChange={(patch) => setHandoff((current) => ({ ...current, ...patch }))}
      />
      <output>{handoff.destinationDirectory ?? ''}</output>
    </>
  )
}
const destination = (): string => screen.getByRole('status').textContent!
const line = (): HTMLElement => screen.getByRole('button', { name: /^Saves to/ })
async function mount(hostId?: 'local' | 'ssh:box'): Promise<void> {
  await act(async () => {
    render(<Harness hostId={hostId} />)
  })
}

it('opens as one folder line, pre-selected from the workspace, with nothing else showing', async () => {
  await mount()
  expect(line().textContent).toBe('Saves to Work/site')
  expect(line().getAttribute('data-next-step-files')).toBe('default')
  expect(screen.queryByRole('button', { name: 'Desktop' })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
})

it('offers Desktop, Downloads and a picker on click; a chip is one click and is remembered', async () => {
  await mount()
  fireEvent.click(line())
  expect(screen.getByText('/Users/maintainer/Work/site')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Desktop' }))
  expect(destination()).toBe('/Users/maintainer/Desktop')
  expect(line().textContent).toBe('Saves to sal/Desktopchanged')
  expect(line().getAttribute('data-next-step-files')).toBe('changed')
  expect(screen.getByRole('button', { name: 'Desktop' }).getAttribute('aria-pressed')).toBe('true')
  expect(useSessionPlaces.getState().recentFolders).toEqual(['/Users/maintainer/Desktop'])
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
  expect(destination()).toBe('/picked/folder')
  expect(screen.getByRole('button', { name: 'folder' }).getAttribute('title')).toBe(
    '/picked/folder'
  )
  expect(useSessionPlaces.getState().recentFolders).toEqual([
    '/picked/folder',
    '/Users/maintainer/Desktop'
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Use default' }))
  expect(destination()).toBe('')
  expect(line().textContent).toBe('Saves to Work/site')
})

it('takes a typed path with Use or Enter and never remembers the session folder itself', async () => {
  await mount()
  fireEvent.click(line())
  const input = screen.getByRole('textbox', { name: 'Folder path' })
  expect(screen.getByRole('button', { name: 'Use' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(input, { target: { value: '  /typed/out  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  expect(destination()).toBe('/typed/out')
  expect((input as HTMLInputElement).value).toBe('')
  fireEvent.change(input, { target: { value: '/Users/maintainer/Work/site' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(destination()).toBe('')
  expect(useSessionPlaces.getState().recentFolders).toEqual(['/typed/out'])
})

it('keeps this computer’s folders off a remote host but still offers the recent ones', async () => {
  useSessionPlaces.setState({ recentFolders: ['/remote/recent'] })
  await mount('ssh:box')
  fireEvent.click(line())
  expect(screen.queryByRole('button', { name: 'Desktop' })).toBeNull()
  expect(screen.getByRole('button', { name: 'recent' })).toBeTruthy()
})
