// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { WorkflowRunHeader } from './WorkflowRunHeader'
import { discoverRunView } from './local-workflow-run.fixtures'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
afterEach(cleanup)

const readAt = new Date(2026, 8, 30, 12, 3).getTime()
const readTime = new Date(readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function view(extra: Partial<LocalWorkflowView>): LocalWorkflowView {
  return { ...discoverRunView(), ...extra }
}

describe('where the run was placed and who asked', () => {
  it('shows the host, mode, choice, reading and a forced reason', () => {
    render(
      <WorkflowRunHeader
        pending={false}
        view={view({
          placement: {
            runsOn: 'fleet',
            mode: 'dispatched-seats',
            choice: 'named',
            forced: 'release night',
            host: { name: 'mw0004', machine: 'mw0004', cores: 10, loadPerCore: 0.1, readAt }
          }
        })}
      />
    )
    expect(
      screen.getByText(
        `Runs on mw0004 · dispatched seats · named · 0.10 load per core, read ${readTime} · forced: release night`
      )
    ).toBeVisible()
  })

  it('says this computer for a local placement and nothing for a run without a host', () => {
    const local = {
      runsOn: 'fleet' as const,
      mode: 'local' as const,
      host: { name: 'mw0003', machine: 'mw0003', cores: 10, loadPerCore: 0.25, readAt }
    }
    const { rerender } = render(
      <WorkflowRunHeader pending={false} view={view({ placement: local })} />
    )
    expect(
      screen.getByText(`Runs on mw0003 · this computer · 0.25 load per core, read ${readTime}`)
    ).toBeVisible()
    rerender(
      <WorkflowRunHeader
        pending={false}
        view={view({ placement: { runsOn: 'local', mode: 'local' } })}
      />
    )
    expect(screen.queryByText(/Runs on/)).toBeNull()
  })

  it('says why a Discover the fleet could not take runs on this computer', () => {
    const fallback =
      'Seats on mw0004 run Claude and Codex on its own subscription logins; Grok cannot run there.'
    render(
      <WorkflowRunHeader
        pending={false}
        view={view({ placement: { runsOn: 'fleet', mode: 'local', fallback } })}
      />
    )
    expect(
      screen.getByText(`Runs on this computer: the fleet could not take it (${fallback})`)
    ).toBeVisible()
  })

  it('shows who asked and their words, the full text kept in the tooltip', () => {
    const request = 'Compare the three cache designs and pick one'
    render(<WorkflowRunHeader pending={false} view={view({ requestedBy: 'Sal', request })} />)
    const line = screen.getByText(`Requested by Sal: “${request}”`)
    expect(line).toBeVisible()
    expect(line).toHaveAttribute('title', `Requested by Sal: “${request}”`)
    expect(line).toHaveClass('truncate')
  })
})
