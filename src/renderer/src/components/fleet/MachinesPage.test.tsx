// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MachinesPage from './MachinesPage'

const mocks = vi.hoisted(() => ({ reader: { inventory: {}, refresh: vi.fn(), reload: vi.fn() } }))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./use-fleet-inventory', () => ({ useFleetInventory: () => mocks.reader }))

function ready(machines: unknown[]) {
  mocks.reader.inventory = {
    phase: 'ready',
    value: {
      ok: true,
      providers: [],
      models: [],
      people: [],
      repositories: [],
      models_fallback: false,
      machines
    }
  }
}

function machine(overrides: Record<string, unknown> = {}) {
  return {
    host: 'mw0002',
    allowed: true,
    ready: true,
    last_beat: new Date(Date.now() - 12_000).toISOString(),
    slots: 4,
    running: 1,
    execution_capabilities: [
      {
        provider: 'claude',
        available: true,
        models: [],
        efforts: [],
        resume: true,
        readonly: false
      }
    ],
    ...overrides
  }
}

afterEach(cleanup)

describe('the Machines view', () => {
  it('lists each machine with the health the console reported', () => {
    ready([
      machine({
        cores: 10,
        load1: 1.2,
        mem_used_bytes: 38 * 1024 ** 3,
        mem_total_bytes: 64 * 1024 ** 3
      })
    ])
    render(<MachinesPage />)
    const row = screen.getByText('mw0002').closest('tr') as HTMLElement
    expect(row.textContent).toContain('1.2 / 10')
    expect(row.textContent).toContain('38.0 / 64.0 GB')
    expect(row.textContent).toContain('3 of 4 free')
    expect(row.textContent).toContain('claude · signed in')
    expect(row.textContent).toContain('12 s ago')
  })

  // Why: an older console sends no health at all; the row must still be readable.
  it('leaves load and memory blank rather than inventing a reading', () => {
    ready([machine()])
    render(<MachinesPage />)
    const row = screen.getByText('mw0002').closest('tr') as HTMLElement
    expect(row.textContent).toContain('—')
    expect(row.textContent).not.toContain('GB')
    expect(row.textContent).toContain('3 of 4 free')
  })

  it('dims a machine that cannot take work and says why', () => {
    ready([machine({ allowed: false })])
    render(<MachinesPage />)
    const row = screen.getByText('mw0002').closest('tr') as HTMLElement
    expect(row.className).toContain('opacity-55')
    expect(row.textContent).toContain('not currently ready for new work')
  })

  it('says in words when there is nothing to show and when the read failed', () => {
    ready([])
    const { unmount } = render(<MachinesPage />)
    expect(screen.getByText(/No fleet machine is registered/)).toBeTruthy()
    unmount()
    mocks.reader.inventory = { phase: 'error', message: 'The console is unreachable.' }
    render(<MachinesPage />)
    expect(screen.getByRole('alert').textContent).toContain('The console is unreachable.')
  })

  it('reads the inventory again on Refresh', () => {
    ready([machine()])
    render(<MachinesPage />)
    screen.getByRole('button', { name: /Refresh/ }).click()
    expect(mocks.reader.reload).toHaveBeenCalled()
  })
})
