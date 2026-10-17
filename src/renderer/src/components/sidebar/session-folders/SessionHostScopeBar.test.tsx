// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionHostFilter } from '@/lib/session-host-scope'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { SidebarHostOption } from '../sidebar-host-options'
import { SessionHostScopeBar } from './SessionHostScopeBar'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, options?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name]))
}))
vi.mock('@/components/host-resources/host-resource-poller', () => ({
  useHostResourceReadings: () => new Map(),
  useHostResourceClock: () => 0
}))
vi.mock('@/components/ui/tooltip', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>
  const Hint = ({ children }: { children?: ReactNode }) => <span role="tooltip">{children}</span>
  return { Tooltip: Pass, TooltipTrigger: Pass, TooltipContent: Hint }
})
// Why: the menu renders inline so its items can be clicked without Radix pointer plumbing.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => null,
    DropdownMenuShortcut: Pass,
    DropdownMenuCheckboxItem: (props: {
      checked: boolean
      onCheckedChange: () => void
      'aria-label': string
    }) => (
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={props.checked}
        aria-label={props['aria-label']}
        onClick={props.onCheckedChange}
      />
    ),
    DropdownMenuItem: (props: {
      children: ReactNode
      disabled?: boolean
      onSelect: () => void
    }) => (
      <button type="button" role="menuitem" disabled={props.disabled} onClick={props.onSelect}>
        {props.children}
      </button>
    )
  }
})
afterEach(cleanup)

const LOCAL: SidebarHostOption = {
  id: 'local',
  kind: 'local',
  label: 'Local',
  detail: 'This computer',
  health: 'local',
  presence: 'local'
}
const BIGMAC: SidebarHostOption = {
  id: 'runtime:bigmac',
  kind: 'runtime',
  label: 'BigMac',
  detail: '',
  health: 'available',
  presence: 'configured'
}
const MINI: SidebarHostOption = {
  ...BIGMAC,
  id: 'runtime:mini',
  label: 'mw0003',
  health: 'disconnected'
}
const VM: SidebarHostOption = { ...BIGMAC, id: 'ssh:vm', kind: 'ssh', label: 'Build VM' }
const HOME: SessionHostFilter = { kinds: ['local'], hiddenHostIds: [] }
const COUNTS = new Map<ExecutionHostId, number>([
  ['local', 3],
  ['runtime:bigmac', 2]
])

const NO_ASKS = new Map<ExecutionHostId, number>()

function renderBar(
  filter: SessionHostFilter,
  hostOptions: SidebarHostOption[],
  extra: {
    sshWithoutWorkspace?: number
    sessionCounts?: ReadonlyMap<ExecutionHostId, number>
    askCounts?: ReadonlyMap<ExecutionHostId, number>
  } = {}
) {
  const setHostFilter = vi.fn()
  const view = render(
    <SessionHostScopeBar
      filter={filter}
      hostOptions={hostOptions}
      sshWithoutWorkspace={extra.sshWithoutWorkspace ?? 0}
      sessionCounts={extra.sessionCounts ?? COUNTS}
      askCounts={extra.askCounts ?? NO_ASKS}
      setHostFilter={setHostFilter}
    />
  )
  return { ...view, setHostFilter }
}

describe('SessionHostScopeBar', () => {
  it('offers exactly Home, paired runtimes and SSH hosts, with no strip of host names', () => {
    renderBar(HOME, [LOCAL, BIGMAC, MINI, VM])
    const group = screen.getByRole('group', { name: 'Sessions from' })
    const pressable = [...group.querySelectorAll('[aria-pressed]')].map((el) =>
      el.getAttribute('aria-label')
    )
    expect(pressable).toEqual(['Home', 'Paired runtimes', 'SSH hosts'])
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Paired runtimes' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.queryByRole('button', { name: /^BigMac/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Choose paired runtimes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose SSH hosts' })).toBeInTheDocument()
    // Home is one computer, so it has no host menu.
    expect(screen.queryByRole('button', { name: /^Choose Home/ })).toBeNull()
  })

  it('adds a kind to what is shown rather than replacing it', () => {
    const { setHostFilter } = renderBar(HOME, [LOCAL, BIGMAC, VM])
    fireEvent.click(screen.getByRole('button', { name: 'SSH hosts' }))
    expect(setHostFilter).toHaveBeenLastCalledWith({ kinds: ['local', 'ssh'], hiddenHostIds: [] })
  })

  it('switches Home to the Globe in one click: this computer and every paired runtime', () => {
    const { setHostFilter } = renderBar(HOME, [LOCAL, BIGMAC, MINI, VM])
    fireEvent.click(screen.getByRole('button', { name: 'Paired runtimes' }))
    expect(setHostFilter).toHaveBeenLastCalledWith({
      kinds: ['local', 'runtime'],
      hiddenHostIds: []
    })
    expect(
      screen.getByText('Globe: sessions on this computer and every paired runtime')
    ).toBeInTheDocument()
  })

  it('switches the Globe back to Home in one click, and only one of them is pressed', () => {
    const globe: SessionHostFilter = { kinds: ['local', 'runtime'], hiddenHostIds: [] }
    const { setHostFilter } = renderBar(globe, [LOCAL, BIGMAC, MINI, VM])
    expect(screen.getByRole('button', { name: 'Paired runtimes' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect(setHostFilter).toHaveBeenLastCalledWith(HOME)
    // The plug is its own toggle: from the Globe it adds SSH hosts without leaving the Globe.
    fireEvent.click(screen.getByRole('button', { name: 'SSH hosts' }))
    expect(setHostFilter).toHaveBeenLastCalledWith({
      kinds: ['local', 'runtime', 'ssh'],
      hiddenHostIds: []
    })
  })

  it('the Globe widens a narrowed view back to every paired runtime', () => {
    const narrowed: SessionHostFilter = {
      kinds: ['local', 'runtime'],
      hiddenHostIds: ['runtime:mini']
    }
    const { setHostFilter } = renderBar(narrowed, [LOCAL, BIGMAC, MINI])
    fireEvent.click(screen.getByRole('button', { name: 'Paired runtimes, 1 of 2 shown' }))
    expect(setHostFilter).toHaveBeenLastCalledWith({
      kinds: ['local', 'runtime'],
      hiddenHostIds: []
    })
  })

  it('with a launch computer picked, the Globe still shows everything, the picker beside it', () => {
    const selectHost = vi.fn().mockResolvedValue(true)
    const setHostFilter = vi.fn()
    render(
      <SessionHostScopeBar
        filter={{ kinds: ['runtime'], hiddenHostIds: ['runtime:mini'] }}
        hostOptions={[LOCAL, BIGMAC, MINI, VM]}
        sshWithoutWorkspace={0}
        sessionCounts={COUNTS}
        askCounts={NO_ASKS}
        setHostFilter={setHostFilter}
        activeHostId="runtime:bigmac"
        selectHost={selectHost}
      />
    )
    // BigMac was picked from the chevron: the Globe is on, narrowed, and says where launches go.
    const globe = screen.getByRole('button', { name: 'Paired runtimes, 1 of 2 shown' })
    expect(globe).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText(/New sessions start on BigMac/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose computer: BigMac' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^BigMac/ })).toBeInTheDocument()
    fireEvent.click(globe)
    expect(setHostFilter).toHaveBeenLastCalledWith({
      kinds: ['local', 'runtime'],
      hiddenHostIds: []
    })
    expect(selectHost).not.toHaveBeenCalled()
    // Home is one click too: the view changes at once, and launches come home.
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect(setHostFilter).toHaveBeenLastCalledWith(HOME)
    expect(selectHost).toHaveBeenCalledWith('local')
  })

  it('narrows a kind to some of its hosts from its menu and says so', () => {
    const narrowed: SessionHostFilter = {
      kinds: ['local', 'runtime'],
      hiddenHostIds: ['runtime:mini']
    }
    const { setHostFilter } = renderBar(narrowed, [LOCAL, BIGMAC, MINI])
    expect(screen.getByRole('button', { name: 'Paired runtimes, 1 of 2 shown' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('menuitemcheckbox', { name: 'BigMac (Connected)' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    const mini = screen.getByRole('menuitemcheckbox', { name: 'mw0003 (Disconnected)' })
    expect(mini).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(mini)
    expect(setHostFilter).toHaveBeenLastCalledWith({
      kinds: ['local', 'runtime'],
      hiddenHostIds: []
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Only Paired runtimes' }))
    expect(setHostFilter).toHaveBeenLastCalledWith({
      kinds: ['runtime'],
      hiddenHostIds: ['runtime:mini']
    })
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'All' })[0])
    expect(setHostFilter).toHaveBeenLastCalledWith({
      kinds: ['local', 'runtime'],
      hiddenHostIds: []
    })
  })

  it('keeps a kind with no hosts in place but unavailable', () => {
    renderBar(HOME, [LOCAL, BIGMAC])
    expect(screen.getByRole('button', { name: 'SSH hosts' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Choose SSH hosts' })).toBeNull()
  })

  it('lists the dispatchable SSH hosts with sessions first, All and None on top, the rest folded', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((name): SidebarHostOption => ({
      ...VM,
      id: `ssh:${name}`,
      label: name
    }))
    const sessionCounts = new Map<ExecutionHostId, number>([
      ['local', 1],
      ['ssh:c', 2]
    ])
    const { setHostFilter } = renderBar(HOME, [LOCAL, a, b, c], {
      sshWithoutWorkspace: 27,
      sessionCounts
    })
    const items = [...document.querySelectorAll('[role^="menuitem"]')].map(
      (item) => item.getAttribute('aria-label') ?? item.textContent
    )
    expect(items).toEqual([
      'All',
      'None',
      'c (Connected)',
      'a (Connected)',
      'b (Connected)',
      'Only SSH hosts'
    ])
    expect(screen.getByRole('group')).toHaveTextContent('27 saved connections without a workspace')
    // Nothing of SSH is shown, so there is nothing for None to turn off.
    expect(screen.getByRole('menuitem', { name: 'None' })).toBeDisabled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'All' }))
    expect(setHostFilter).toHaveBeenLastCalledWith({ kinds: ['local', 'ssh'], hiddenHostIds: [] })
  })

  it('None turns a kind off but never leaves the list empty', () => {
    const both: SessionHostFilter = { kinds: ['local', 'ssh'], hiddenHostIds: [] }
    const first = renderBar(both, [LOCAL, VM])
    fireEvent.click(screen.getByRole('menuitem', { name: 'None' }))
    expect(first.setHostFilter).toHaveBeenLastCalledWith(HOME)
    first.unmount()
    const sshOnly: SessionHostFilter = { kinds: ['ssh'], hiddenHostIds: [] }
    const second = renderBar(sshOnly, [LOCAL, VM])
    fireEvent.click(screen.getByRole('menuitem', { name: 'None' }))
    expect(second.setHostFilter).toHaveBeenLastCalledWith(sshOnly)
  })

  it('marks how many hosts in view have sessions and when a host out of view is asking', () => {
    const narrowed: SessionHostFilter = {
      kinds: ['local', 'runtime'],
      hiddenHostIds: ['runtime:mini']
    }
    renderBar(narrowed, [LOCAL, BIGMAC, MINI, VM], {
      sessionCounts: new Map<ExecutionHostId, number>([
        ['local', 3],
        ['runtime:bigmac', 2],
        ['runtime:mini', 1]
      ]),
      askCounts: new Map<ExecutionHostId, number>([['runtime:mini', 1]])
    })
    expect(screen.getByTestId('runtime-hosts-with-sessions')).toHaveTextContent('1')
    expect(
      screen.getByRole('button', {
        name: 'Paired runtimes, 1 of 2 shown, A session on a host not shown needs you'
      })
    ).toBeInTheDocument()
    // SSH is off, so no host of it is in view to count.
    expect(screen.queryByTestId('ssh-hosts-with-sessions')).toBeNull()
    expect(screen.queryByTestId('local-hosts-with-sessions')).toBeNull()
  })

  it('keeps the plug, disabled, to say a workspace is missing when no SSH host can be used', () => {
    renderBar(HOME, [LOCAL], { sshWithoutWorkspace: 30 })
    expect(screen.getByRole('button', { name: 'SSH hosts' })).toBeDisabled()
    expect(
      screen.getByText('Add a workspace on an SSH host to see its sessions here')
    ).toBeInTheDocument()
  })

  it('is not there while this computer is the only host', () => {
    const { container } = renderBar(HOME, [LOCAL])
    expect(container).toBeEmptyDOMElement()
  })
})
