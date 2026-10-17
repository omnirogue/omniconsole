// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalWorkflowDraft } from '../../../../shared/local-workflow-draft'
import { WorkflowRunsOnSelect } from './WorkflowRunsOnSelect'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
// A native select stands in for Radix, which happy-dom cannot open.
vi.mock('./workflow-graph-controls', () => ({
  WorkflowSelect: ({
    value,
    options,
    onChange
  }: {
    value: string
    options: { value: string; label: string }[]
    onChange: (value: string) => void
  }) => (
    <select aria-label="Run on" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}))

const listTargets = vi.fn()
const hosts = [
  { name: 'mw0003', machine: 'mw0003', hostname: 'mw0003.local', ssh: null, local: true },
  { name: 'mw0004', machine: 'mw0004', hostname: 'mw0004.local', ssh: 'mw0004', local: false },
  { name: 'laptop', machine: 'laptop', hostname: 'laptop.local', ssh: 'laptop', local: false }
]
beforeEach(() => {
  rpc.mockResolvedValue({ path: '/hosts.md', hosts })
  listTargets.mockResolvedValue([{ id: 't2', host: '10.0.0.2', configHost: 'mw0004' }])
  Object.assign(window, { api: { ssh: { listTargets } } })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const draft = createLocalWorkflowDraft('council', 'Q')

describe('Run on: <host>', () => {
  it('offers each fleet host and sets the draft fields a pick implies', async () => {
    const onChange = vi.fn()
    render(<WorkflowRunsOnSelect draft={draft} onChange={onChange} />)
    expect(await screen.findByRole('option', { name: 'Run on: mw0003 (this computer)' }))
    expect(rpc).toHaveBeenCalledWith({ kind: 'local' }, 'localWorkflow.fleetHosts', {})
    const select = screen.getByLabelText('Run on')

    fireEvent.change(select, { target: { value: 'host:mw0004' } })
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({
      runsOn: 'fleet',
      runsOnHost: 'mw0004',
      runsOnHostId: 'ssh:t2'
    })
    fireEvent.change(select, { target: { value: 'host:mw0003' } })
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({
      runsOn: 'fleet',
      runsOnHost: 'mw0003',
      runsOnHostId: 'local'
    })
    // No SSH target is that host's alias: the name goes without a host id.
    fireEvent.change(select, { target: { value: 'host:laptop' } })
    const laptop = onChange.mock.calls.at(-1)![0]
    expect(laptop).toMatchObject({ runsOn: 'fleet', runsOnHost: 'laptop' })
    expect(laptop).not.toHaveProperty('runsOnHostId')
  })

  it('clears the host when the fleet or this computer is picked, and shows a saved host', async () => {
    const onChange = vi.fn()
    const saved = { ...draft, runsOn: 'fleet' as const, runsOnHost: 'mw0004', runsOnHostId: 'x' }
    render(<WorkflowRunsOnSelect draft={saved} onChange={onChange} />)
    await screen.findByRole('option', { name: 'Run on: mw0003 (this computer)' })
    const select = screen.getByLabelText('Run on')
    expect(select).toHaveValue('host:mw0004')
    fireEvent.change(select, { target: { value: 'local' } })
    const local = onChange.mock.calls.at(-1)![0]
    expect(local.runsOn).toBe('local')
    expect(local).not.toHaveProperty('runsOnHost')
    expect(local).not.toHaveProperty('runsOnHostId')
    fireEvent.change(select, { target: { value: 'fleet' } })
    expect(onChange.mock.calls.at(-1)![0]).not.toHaveProperty('runsOnHost')
  })

  it('offers no hosts where the runtime lacks the method, keeping a saved one selectable', async () => {
    rpc.mockRejectedValue(new Error('Unknown method'))
    const saved = { ...draft, runsOnHost: 'mw0004' }
    render(<WorkflowRunsOnSelect draft={saved} onChange={vi.fn()} />)
    await screen.findByRole('option', { name: 'Run on: mw0004' })
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByLabelText('Run on')).toHaveValue('host:mw0004')
  })
})
