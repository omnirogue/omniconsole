// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { HostResourceMeters } from './HostResourceMeters'
import type { HostResourceReading } from '../../../../shared/host-resource-model'
vi.mock('./host-resource-poller', () => ({ useHostResourceClock: () => 100_000 }))
afterEach(cleanup)
const reading: HostResourceReading = {
  hostKey: 'runtime:worker',
  state: 'ok',
  readAt: 100_000,
  liveSessions: 3,
  memory: {
    totalMemory: 16 * 1024 ** 3,
    availableMemory: 4 * 1024 ** 3,
    cpuCoreCount: 8,
    loadAverage1m: 4
  }
}
it('shows memory used, normalized CPU load and live sessions from the host', () => {
  render(<HostResourceMeters reading={reading} />)
  expect(screen.getByRole('progressbar', { name: /Memory: 75% used/ })).toHaveAttribute(
    'aria-valuenow',
    '75'
  )
  expect(screen.getByRole('progressbar', { name: 'CPU load 0.50/core · 8 cores' })).toHaveAttribute(
    'aria-valuenow',
    '50'
  )
  expect(screen.getByText('3 live sessions')).toBeInTheDocument()
})
it.each([null, { ...reading, readAt: 1 }, { ...reading, state: 'unavailable' as const }])(
  'does not present unavailable or stale capacity as free resources',
  (value) => {
    render(<HostResourceMeters reading={value} />)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByText('Capacity unavailable')).toBeInTheDocument()
  }
)
