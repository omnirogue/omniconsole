// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { SessionDetails } from './SessionDetails'
import { sessionDetailsMore, type SessionDetailsFacts } from './session-details-facts'
import { nextActionChainFixture } from './next-action-fixture'

const opened = { create: 0, attach: 0, sheet: 0 }
vi.mock('@/store', () => {
  const state = {}
  return {
    useAppStore: Object.assign((select: (state: unknown) => unknown) => select(state), {
      getState: () => state
    })
  }
})
vi.mock('@/components/tasks/CreateTaskDialog', () => ({
  CreateTaskDialog: ({ session }: { session: SidebarSession | null }) => {
    if (session) {
      opened.create += 1
    }
    return null
  }
}))
vi.mock('@/components/tasks/AttachToTaskDialog', () => ({
  AttachToTaskDialog: ({ session }: { session: SidebarSession | null }) => {
    if (session) {
      opened.attach += 1
    }
    return null
  }
}))
vi.mock('@/components/tasks/SessionTaskSheet', () => ({
  SessionTaskSheet: () => {
    opened.sheet += 1
    return null
  }
}))

afterEach(() => {
  cleanup()
  opened.create = 0
  opened.attach = 0
  opened.sheet = 0
})

const session = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'folder:1',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  kind: 'structured',
  label: 'IDE Claude local acceptance 0917',
  workspaceLabel: 'omni-ide',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
} satisfies SidebarSession

function facts(overrides: Partial<SessionDetailsFacts> = {}): SessionDetailsFacts {
  return {
    session,
    agent: { name: 'Claude Code', state: 'running', detail: 'working' },
    runsOn: 'This device',
    workspace: 'omni-ide · main-next',
    savesTo: 'workspaces/local',
    task: null,
    more: sessionDetailsMore(nextActionChainFixture()),
    ...overrides
  }
}

it('puts agent, location and workspace on one line and an unlinked task under More', () => {
  const given = facts()
  const before = structuredClone(given)
  render(<SessionDetails facts={given} />)
  expect(
    [...document.querySelectorAll('[data-next-action-fact]')].map((row) =>
      row.getAttribute('data-next-action-fact')
    )
  ).toEqual([
    'agent',
    'runs-on',
    'workspace',
    'launched-with',
    'task',
    'receipts',
    'verdicts',
    'files',
    'timings'
  ])
  expect(document.querySelector('[data-next-action-fact="launched-with"]')!.textContent).toContain(
    'Nothing attached, launch list not kept'
  )
  const where = document.querySelector('[data-next-action-where]')!
  expect(where.textContent).toBe('Claude Coderunning·This device·omni-ide · main-next')
  expect(
    document.querySelector('[data-next-action-more] [data-next-action-fact="task"]')
  ).toBeTruthy()
  // Without a Conversations folder, "Saves to" would only repeat the workspace.
  expect(document.querySelector('[data-next-action-fact="saves-to"]')).toBeNull()
  expect(screen.getByText('Claude Code')).toBeTruthy()
  expect(document.querySelector('[data-next-action-agent-state="running"]')!.textContent).toBe(
    'running'
  )
  expect(screen.getByText('This device')).toBeTruthy()
  for (const absent of ['Plan', 'Done when', 'Up next', '(location, not an actor)']) {
    expect(screen.queryByText(absent)).toBeNull()
  }
  // Read-only: no field to type in, and the facts it was handed are untouched.
  expect(document.querySelectorAll('textarea, input')).toHaveLength(0)
  expect(given).toEqual(before)
})

it('counts the receipts, verdicts, changed files and timings behind More', () => {
  render(
    <SessionDetails facts={facts({ more: sessionDetailsMore(nextActionChainFixture(), 7) })} />
  )
  expect(document.querySelector('[data-next-action-fact="receipts"]')!.textContent).toContain('1')
  expect(document.querySelector('[data-next-action-fact="verdicts"]')!.textContent).toContain(
    'none'
  )
  expect(document.querySelector('[data-next-action-fact="files"]')!.textContent).toContain(
    '7 changed'
  )
  expect(document.querySelector('[data-next-action-fact="timings"]')!.textContent).toContain(
    'started'
  )
})

it('shows the Conversations folder a session saves to', () => {
  render(<SessionDetails facts={facts({ savesTo: 'Launch week', savesToFolder: true })} />)
  expect(document.querySelector('[data-next-action-fact="saves-to"]')!.textContent).toContain(
    'Launch week'
  )
})

it('shows "none" for Files when the workspace store has no changed-file entry', () => {
  render(<SessionDetails facts={facts()} />)
  expect(document.querySelector('[data-next-action-fact="files"]')!.textContent).toContain('none')
})

it('offers the location as text until a dispatch menu is mounted in its slot', () => {
  render(<SessionDetails facts={facts()} runsOnMenu={<button type="button">This Mac ▾</button>} />)
  expect(screen.getByRole('button', { name: 'This Mac ▾' })).toBeTruthy()
  expect(screen.queryByText('This device')).toBeNull()
})

it('routes Create and Attach to the existing task dialogs', () => {
  render(<SessionDetails facts={facts()} />)
  expect(document.querySelector('[data-next-action-fact="task"]')!.textContent).toContain('none')
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  expect(opened.create).toBe(1)
  expect(opened.attach).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
  expect(opened.attach).toBe(1)
})

it('shows a bound task by title, outside More, and opens it', () => {
  render(<SessionDetails facts={facts({ task: { id: 'btk_1', title: 'Wave 3 acceptance' } })} />)
  expect(screen.getByText('Wave 3 acceptance')).toBeTruthy()
  expect(
    document.querySelector('[data-next-action-more] [data-next-action-fact="task"]')
  ).toBeNull()
  expect(screen.queryByRole('button', { name: 'Create' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'open' }))
  expect(opened.sheet).toBe(1)
})

it('routes every More link to its supplied viewer', () => {
  const viewers = {
    onOpenReceipts: vi.fn(),
    onOpenVerdicts: vi.fn(),
    onOpenFiles: vi.fn()
  }
  render(<SessionDetails facts={facts()} viewers={viewers} />)
  for (const [id, callback] of Object.entries({
    receipts: viewers.onOpenReceipts,
    verdicts: viewers.onOpenVerdicts,
    files: viewers.onOpenFiles
  })) {
    fireEvent.click(document.querySelector(`[data-next-action-fact="${id}"] button`)!)
    expect(callback).toHaveBeenCalledOnce()
  }
  // Why: timings are inline facts in the mockup, so the row states them and links nowhere.
  expect(document.querySelector('[data-next-action-fact="timings"] button')).toBeNull()
})

it('places the mounted activity and files sections after the facts and extra context in More', () => {
  render(
    <SessionDetails
      facts={facts()}
      sections={{
        activity: <p>Reading the release notes</p>,
        filesAndLinks: <p>page.html</p>,
        more: <p>First recorded request</p>
      }}
    />
  )
  const order = [
    ...document.querySelectorAll('[data-next-action-fact], [data-next-action-section]')
  ].map(
    (node) =>
      node.getAttribute('data-next-action-fact') ?? node.getAttribute('data-next-action-section')
  )
  expect(order).toEqual([
    'agent',
    'runs-on',
    'workspace',
    'launched-with',
    'activity',
    'files-and-links',
    'task',
    'receipts',
    'verdicts',
    'files',
    'timings'
  ])
  expect(screen.getByRole('region', { name: 'Activity' }).textContent).toContain(
    'Reading the release notes'
  )
  expect(screen.getByRole('region', { name: 'Files & links' }).textContent).toContain('page.html')
  const more = document.querySelector('[data-next-action-more]')!
  expect(more.textContent).toContain('First recorded request')
})

it('renders no section chrome when a mount supplies none', () => {
  render(<SessionDetails facts={facts()} />)
  expect(document.querySelector('[data-next-action-section]')).toBeNull()
})
