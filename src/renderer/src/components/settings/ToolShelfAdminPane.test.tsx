// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))

import { EverybodysShelf } from './ToolShelfAdminPane'

const accessMock = {
  mine: vi.fn(),
  people: vi.fn(),
  person: vi.fn(),
  change: vi.fn(),
  sections: vi.fn(),
  bulk: vi.fn()
}

const finance = {
  key: 'finance',
  label: 'Finance',
  groups: ['payments'],
  read_ref: '@section:finance:read',
  write_ref: '@section:finance:write',
  read_count: 12,
  write_count: 7,
  floor_count: 3
}

const people = {
  digest: 'abcdef0123456789',
  super_admins: ['human:emp_sal'],
  hard_deny: ['stripe_acme.refund'],
  principals: [
    {
      principal: 'agent:luna-scout',
      kind: 'agent',
      count: 4,
      overrides: [],
      sections: {
        finance: { read: { granted: 0, total: 12 }, write: { granted: 0, total: 7, floor: 3 } }
      }
    },
    {
      principal: 'human:emp_shona',
      kind: 'human',
      count: 21,
      overrides: [],
      sections: {
        finance: { read: { granted: 12, total: 12 }, write: { granted: 0, total: 7, floor: 3 } }
      }
    }
  ],
  catalogue: { connectors: [] },
  sections: [finance],
  templates: { 'customer-service': { label: 'Customer Service', sections: [] } }
}

function ok<T>(data: T) {
  return { ok: true as const, data }
}

beforeEach(() => {
  for (const operation of Object.values(accessMock)) {
    operation.mockReset()
  }
  accessMock.people.mockResolvedValue(ok(people))
  accessMock.sections.mockResolvedValue(
    ok({ digest: people.digest, sections: [{ ...finance, capabilities: [] }], templates: {} })
  )
  accessMock.change.mockResolvedValue(ok({ ...people, principal: 'human:emp_shona' }))
  accessMock.bulk.mockResolvedValue(
    ok({ digest: people.digest, dry_run: false, changes: [], diff: [], applied: [], removed: [] })
  )
  Object.assign(window as unknown as { api: unknown }, { api: { consoleAccess: accessMock } })
})

afterEach(cleanup)

describe('the Tool Shelf matrix', () => {
  it('puts every principal on a row, humans first, with the hub’s effective state', async () => {
    render(<EverybodysShelf />)

    const rows = await screen.findAllByRole('row')
    // Two header rows (sections, then Read/Write), then the people.
    expect(rows[2]).toHaveTextContent('human:emp_shona')
    expect(rows[3]).toHaveTextContent('agent:luna-scout')
    expect(screen.getByTestId('shelf-cell-human:emp_shona-finance-read')).toHaveAttribute(
      'data-state',
      'on'
    )
    expect(screen.getByTestId('shelf-cell-human:emp_shona-finance-write')).toHaveAttribute(
      'data-state',
      'off'
    )
  })

  it('writes one grant on the section ref when a cell is turned on', async () => {
    render(<EverybodysShelf />)

    fireEvent.click(await screen.findByTestId('shelf-cell-human:emp_shona-finance-write'))
    fireEvent.change(screen.getByLabelText('Reason (recorded in the audit ledger)'), {
      target: { value: 'covering month end' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(accessMock.change).toHaveBeenCalledWith({
        ref: 'human:emp_shona',
        change: {
          op: 'grant',
          capability: '@section:finance:write',
          reason: 'covering month end',
          expected_digest: 'abcdef0123456789'
        }
      })
    )
  })

  it('offers a removal, not a second row, when a standing grant is what turned the cell on', async () => {
    accessMock.people.mockResolvedValue(
      ok({
        ...people,
        principals: [
          {
            ...people.principals[1],
            overrides: [
              {
                id: 'apl_abcd1234',
                principal: 'human:emp_shona',
                action: 'grant',
                capability: '@section:finance:read',
                reason: 'ACME invoices',
                issued_by: 'emp_sal',
                expired: false
              }
            ]
          }
        ]
      })
    )
    render(<EverybodysShelf />)

    fireEvent.click(await screen.findByTestId('shelf-cell-human:emp_shona-finance-read'))
    fireEvent.change(screen.getByLabelText('Reason (recorded in the audit ledger)'), {
      target: { value: 'left the team' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(accessMock.change).toHaveBeenCalledWith({
        ref: 'human:emp_shona',
        change: {
          op: 'remove',
          override_id: 'apl_abcd1234',
          expected_digest: 'abcdef0123456789'
        }
      })
    )
  })

  it('never lets a floor-only cell be clicked', async () => {
    accessMock.people.mockResolvedValue(
      ok({
        ...people,
        principals: [
          {
            ...people.principals[1],
            sections: {
              finance: {
                read: { granted: 12, total: 12 },
                write: { granted: 0, total: 0, floor: 3 }
              }
            }
          }
        ]
      })
    )
    render(<EverybodysShelf />)

    const cell = await screen.findByTestId('shelf-cell-human:emp_shona-finance-write')
    expect(cell).toBeDisabled()
    expect(cell).toHaveAttribute('data-state', 'floor')
  })

  it('asks for one reason before a column changes everybody', async () => {
    render(<EverybodysShelf />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Turn off write Finance for everybody selected'
      })
    )
    expect(
      await screen.findByText('Give one reason for this change — it is recorded.')
    ).toBeInTheDocument()
    expect(accessMock.bulk).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Reason for this bulk change'), {
      target: { value: 'nobody writes to finance' }
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Turn off write Finance for everybody selected' })
    )

    await waitFor(() =>
      expect(accessMock.bulk).toHaveBeenCalledWith({
        change: {
          reason: 'nobody writes to finance',
          expected_digest: 'abcdef0123456789',
          column: { section: 'finance', access: 'write', on: false }
        }
      })
    )
  })

  it('applies a template to exactly the people who were ticked', async () => {
    render(<EverybodysShelf />)

    fireEvent.click(await screen.findByLabelText('Select human:emp_shona'))
    fireEvent.change(screen.getByLabelText('Reason for this bulk change'), {
      target: { value: 'moving to support' }
    })
    fireEvent.change(screen.getByLabelText('Template'), {
      target: { value: 'customer-service' }
    })

    await waitFor(() =>
      expect(accessMock.bulk).toHaveBeenCalledWith({
        change: {
          reason: 'moving to support',
          expected_digest: 'abcdef0123456789',
          template: 'customer-service',
          principals: ['human:emp_shona']
        }
      })
    )
  })

  it('renders the hub’s refusal in the hub’s own words', async () => {
    accessMock.change.mockResolvedValue({
      ok: false,
      error: {
        code: 'access_admin_required',
        message: 'Only the estate’s super admins may change access.'
      }
    })
    render(<EverybodysShelf />)

    fireEvent.click(await screen.findByTestId('shelf-cell-human:emp_shona-finance-write'))
    fireEvent.change(screen.getByLabelText('Reason (recorded in the audit ledger)'), {
      target: { value: 'let me in' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(
      await screen.findByText('Only the estate’s super admins may change access.')
    ).toBeInTheDocument()
  })
})
