// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TeamSessionSection } from './TeamSessionSection'
import { row } from './session-ledger-test-fixtures'
afterEach(cleanup)
it("shows every finished row of the server's today answer without re-cutting the day by the UTC clock", () => {
  // Why: the server cuts "today" in the caller's zone; a Z-suffixed server clock carries no
  // offset, so a client-side re-cut would hide rows finished late in the caller's local day.
  render(
    <TooltipProvider>
      <TeamSessionSection
        title="Today"
        live={false}
        retry={vi.fn()}
        result={{
          ok: true,
          overflow: 0,
          server_time: '2026-09-13T00:10:00Z',
          rows: [
            row('today', { state: 'done', ended_at: '2026-09-13T00:05:00Z' }),
            row('late-local', { state: 'done', ended_at: '2026-09-12T23:30:00Z' }),
            row('running', { state: 'running' })
          ]
        }}
      />
    </TooltipProvider>
  )
  expect(screen.getByText('today')).toBeTruthy()
  expect(screen.getByText('late-local')).toBeTruthy()
  expect(screen.queryByText('running')).toBeNull()
})
