// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TeamSessionRow } from './TeamSessionRow'
import { row, serverTime } from './session-ledger-test-fixtures'
afterEach(cleanup)
it('renders sparse metadata without empty separators', () => {
  render(
    <TooltipProvider>
      <ul>
        <TeamSessionRow
          row={row('Alice', {
            agent: 'codex',
            model: 'model',
            repo: null,
            branch: null,
            card_title: null,
            last_action: null,
            files_touched: [],
            activity_summary: {}
          })}
          serverTime={serverTime}
        />
      </ul>
    </TooltipProvider>
  )
  expect(screen.getByText('Alice · Codex · model')).toBeTruthy()
  expect(screen.getByRole('listitem').textContent).toBe('Alice · Codex · modelthis minute')
})
it('shows repo/branch and the action target with existing state vocabulary', () => {
  render(
    <TooltipProvider>
      <ul>
        <TeamSessionRow
          row={row('Alice', {
            repo: 'repo',
            branch: 'branch',
            state: 'waiting',
            last_action: { kind: 'edit', target: 'src/entry.ts' }
          })}
          serverTime={serverTime}
        />
      </ul>
    </TooltipProvider>
  )
  expect(screen.getByText('Alice · repo#branch')).toBeTruthy()
  expect(screen.getByText('src/entry.ts')).toBeTruthy()
  expect(screen.getByRole('img', { name: 'Waiting' })).toBeTruthy()
})
