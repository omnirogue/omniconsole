// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleConversationFleetInventory } from '../../../../../shared/console-conversation-fleet-types'
import { MenuFleet } from './MenuFleet'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

afterEach(cleanup)

function machine(overrides: Record<string, unknown> = {}) {
  return {
    host: 'mw0002',
    allowed: true,
    ready: true,
    last_beat: '2026-09-13T10:00:00Z',
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

function inventory(machines: unknown[]): ConsoleConversationFleetInventory {
  return {
    ok: true,
    providers: [],
    models: [],
    people: [],
    repositories: [],
    models_fallback: false,
    machines
  } as unknown as ConsoleConversationFleetInventory
}

describe('🚀 fleet section', () => {
  it('offers automatic first and every machine the console reported', () => {
    render(
      <MenuFleet
        inventory={{
          phase: 'ready',
          value: inventory([machine(), machine({ host: 'mw0003' })])
        }}
        selected={null}
        onChoose={vi.fn()}
      />
    )
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(3)
    expect(items[0]!.textContent).toContain('Dispatch to fleet · automatic')
    expect(items[1]!.textContent).toContain('mw0002')
    expect(items[2]!.textContent).toContain('mw0003')
  })

  it('shows load and memory when the runner reported them', () => {
    render(
      <MenuFleet
        inventory={{
          phase: 'ready',
          value: inventory([
            machine({
              cores: 10,
              load1: 1.2,
              mem_used_bytes: 38 * 1024 ** 3,
              mem_total_bytes: 64 * 1024 ** 3
            })
          ])
        }}
        selected={null}
        onChoose={vi.fn()}
      />
    )
    expect(screen.getByText(/load 1.2\/10/)).toBeTruthy()
    expect(screen.getByText(/38.0 \/ 64.0 GB/)).toBeTruthy()
    expect(screen.getByText(/3 of 4 slots free/)).toBeTruthy()
    expect(screen.getByText(/claude · signed in/)).toBeTruthy()
  })

  // Why: a console that does not report health yet must leave the row clean, never show a zero.
  it('hides the load bar and memory when the console sent no health', () => {
    const { container } = render(
      <MenuFleet
        inventory={{ phase: 'ready', value: inventory([machine()]) }}
        selected={null}
        onChoose={vi.fn()}
      />
    )
    expect(screen.queryByText(/load /)).toBeNull()
    expect(screen.queryByText(/GB/)).toBeNull()
    expect(container.querySelector('[style*="width"]')).toBeNull()
    expect(screen.getByText(/3 of 4 slots free/)).toBeTruthy()
  })

  it('dims a machine the console will not admit, says why and refuses the click', () => {
    const choose = vi.fn()
    render(
      <MenuFleet
        inventory={{
          phase: 'ready',
          value: inventory([machine({ host: 'mw0004', allowed: false })])
        }}
        selected={null}
        onChoose={choose}
      />
    )
    const row = screen.getByText('mw0004').closest('[data-fleet-machine]') as HTMLElement
    expect(row.className).toContain('opacity-55')
    expect(screen.getByText(/not currently ready for new work/)).toBeTruthy()
    screen.getByRole('menuitem', { name: /mw0004/ }).click()
    expect(choose).not.toHaveBeenCalled()
  })

  it('says what is happening while the inventory is read and when it fails', () => {
    const { rerender } = render(
      <MenuFleet inventory={{ phase: 'loading' }} selected={null} onChoose={vi.fn()} />
    )
    expect(screen.getByText(/Checking fleet availability/)).toBeTruthy()
    rerender(
      <MenuFleet
        inventory={{ phase: 'error', message: 'The console is unreachable.' }}
        selected={null}
        onChoose={vi.fn()}
      />
    )
    expect(screen.getByText('The console is unreachable.')).toBeTruthy()
  })
})
