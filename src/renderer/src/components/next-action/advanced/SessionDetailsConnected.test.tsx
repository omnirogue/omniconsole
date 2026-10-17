// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import { sessionDetailsMore, type SessionDetailsFacts } from '../session-details-facts'
import { nextActionChainFixture } from '../next-action-fixture'
import { SessionDetailsConnected } from './SessionDetailsConnected'

/**
 * Why this test exists: the More rows used to share ONE viewer — Files and Verdicts both opened the
 * stage-history dialog, which lists a run's output artifacts, not the workspace's changed files —
 * and every link was gated on an outcome, so the common no-outcome conversation showed "N changed"
 * with nothing to click.
 */
const calls = vi.hoisted(() => ({
  diffs: [] as unknown[],
  doneWhen: [] as unknown[]
}))
const state = {
  openAllDiffs: (...args: unknown[]) => calls.diffs.push(args),
  getKnownWorktreeById: (id: string) => (id === 'folder:1' ? { id, path: '/workspace' } : undefined)
}
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (value: unknown) => unknown) => select(state), {
    getState: () => state
  })
}))
vi.mock('../use-done-when-list', () => ({
  openDoneWhenList: (chainId: string) => calls.doneWhen.push(chainId)
}))
vi.mock('@/components/session-team/PlanRowAction', () => ({
  PlanRowAction: () => <div>Seats and plan history</div>
}))
vi.mock('./RunsOnMenu', () => ({ RunsOnMenu: () => <button>Runs on ▾</button> }))
vi.mock('@/components/tasks/CreateTaskDialog', () => ({ CreateTaskDialog: () => null }))
vi.mock('@/components/tasks/AttachToTaskDialog', () => ({ AttachToTaskDialog: () => null }))
vi.mock('@/components/tasks/SessionTaskSheet', () => ({ SessionTaskSheet: () => null }))

const session = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'folder:1',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  kind: 'structured',
  label: 'Wave 3 acceptance',
  workspaceLabel: 'omni-ide',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
} satisfies SidebarSession

function facts(
  changedFiles: number,
  chain: SessionChain | null = nextActionChainFixture()
): SessionDetailsFacts {
  return {
    session,
    agent: { name: 'Claude Code', state: 'running', detail: 'working' },
    runsOn: 'This Mac',
    workspace: 'omni-ide · main-next',
    savesTo: 'workspaces/local',
    task: null,
    more: sessionDetailsMore(chain, changedFiles)
  }
}

function open(id: string): void {
  fireEvent.click(document.querySelector(`[data-next-action-fact="${id}"] button`)!)
}

beforeEach(() => {
  calls.diffs = []
  calls.doneWhen = []
})
afterEach(cleanup)

it('opens the workspace’s changed files from Files, not the stage history', () => {
  const chain = nextActionChainFixture()
  render(<SessionDetailsConnected facts={facts(7, chain)} chain={chain} />)
  expect(screen.getByText('7 changed')).toBeTruthy()
  open('files')
  expect(calls.diffs).toEqual([['folder:1', '/workspace']])
  expect(screen.queryByText('Seats and plan history')).toBeNull()
})

// Why: the frozen model's normal case — a lone prompt creates no chain, but the workspace is dirty.
it('links Files even when the conversation never set an outcome', () => {
  render(<SessionDetailsConnected facts={facts(3, null)} chain={null} />)
  expect(screen.getByText('3 changed')).toBeTruthy()
  open('files')
  expect(calls.diffs).toEqual([['folder:1', '/workspace']])
  // Why: receipts and verdicts really do come from the chain, so those rows stay unlinked.
  expect(document.querySelector('[data-next-action-fact="receipts"] button')).toBeNull()
  expect(document.querySelector('[data-next-action-fact="verdicts"] button')).toBeNull()
})

it('offers no Files link when nothing changed', () => {
  const chain = nextActionChainFixture()
  render(<SessionDetailsConnected facts={facts(0, chain)} chain={chain} />)
  expect(document.querySelector('[data-next-action-fact="files"] button')).toBeNull()
})

it('keeps receipts and verdicts on their own viewers', () => {
  const chain = nextActionChainFixture()
  render(<SessionDetailsConnected facts={facts(7, chain)} chain={chain} />)
  open('receipts')
  expect(calls.doneWhen).toEqual(['chain'])
  expect(calls.diffs).toEqual([])
  open('verdicts')
  expect(screen.getByText('Seats and plan history')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Verdicts' })).toBeTruthy()
  expect(screen.queryByText('Stage history')).toBeNull()
})
