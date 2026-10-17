import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleAccessClient as client } from './console-access-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

const fetchMock = vi.fn<typeof fetch>()
const current = vi.fn(() => true)

function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
}

function requested(index = 0): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit]
  return { url, init }
}

const shelf = {
  principal: 'human:emp_shona',
  digest: 'abcdef0123456789',
  capabilities: [
    {
      id: 'stripe_acme.read',
      label: 'Stripe — ACME (read)',
      connector: 'stripe_acme',
      action_class: 'read_only',
      read_only: true,
      requires_approval: false,
      company: 'acme'
    }
  ],
  overrides: [
    {
      id: 'apl_abcd1234',
      principal: 'human:emp_shona',
      action: 'grant',
      capability: 'stripe_acme.read',
      reason: 'ACME invoices',
      issued_by: 'emp_sal',
      expires_at: null,
      expired: false
    }
  ],
  sources: {
    'stripe_acme.read': [{ layer: 'principal', name: 'human:emp_shona', effect: 'granted' }]
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  current.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'test-person-only',
      baseUrl: 'https://console.test',
      principal: 'test-person',
      isCurrent: current
    }
  } as never)
})

describe('the Tool Shelf read contract', () => {
  it('reads my own tools on the signed connection', async () => {
    reply({ principal: 'human:emp_shona', capabilities: [], count: 0 })
    const result = await client.mine()
    expect(result.ok && result.data.principal).toBe('human:emp_shona')
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/access/mine')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
  })

  it('searches my tools by intent with the query encoded', async () => {
    reply({
      principal: 'human:emp_sal',
      capabilities: [],
      search: { query: 'refund a customer', results: [] }
    })
    const result = await client.mine({ q: 'refund a customer' })
    expect(result.ok).toBe(true)
    expect(requested().url).toBe('https://console.test/api/access/mine?q=refund%20a%20customer')
  })

  it('reads one principal’s shelf and keeps its overrides and sources', async () => {
    reply(shelf)
    const result = await client.person({ ref: 'human:emp_shona' })
    expect(result.ok && result.data.overrides[0].id).toBe('apl_abcd1234')
    expect(result.ok && result.data.sources['stripe_acme.read'][0].layer).toBe('principal')
    expect(requested().url).toBe('https://console.test/api/admin/access/people/human:emp_shona')
  })

  it('never accepts another principal’s shelf as the one asked for', async () => {
    reply({ ...shelf, principal: 'human:emp_sal' })
    const result = await client.person({ ref: 'human:emp_shona' })
    expect(result.ok).toBe(false)
  })

  it('refuses a principal that is not a principal before any request', async () => {
    const result = await client.person({ ref: '../policy/grant' })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'The workflow request does not match this operation.'
      }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the Tool Shelf change contract', () => {
  it('sends a grant as a PATCH with its reason and digest', async () => {
    reply({ ...shelf, saved: shelf.overrides[0] })
    const result = await client.change({
      ref: 'human:emp_shona',
      change: {
        op: 'grant',
        capability: 'stripe_acme.read',
        reason: 'ACME invoices',
        expected_digest: 'abcdef0123456789'
      }
    })
    expect(result.ok).toBe(true)
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/admin/access/people/human:emp_shona')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({
      op: 'grant',
      capability: 'stripe_acme.read',
      reason: 'ACME invoices',
      expected_digest: 'abcdef0123456789'
    })
  })

  it('sends a removal by override id', async () => {
    reply({ ...shelf, principal: 'agent:luna-scout', overrides: [], removed: shelf.overrides[0] })
    const result = await client.change({
      ref: 'agent:luna-scout',
      change: { op: 'remove', override_id: 'apl_abcd1234', expected_digest: 'abcdef0123456789' }
    })
    expect(result.ok).toBe(true)
    expect(JSON.parse(String(requested().init.body))).toEqual({
      op: 'remove',
      override_id: 'apl_abcd1234',
      expected_digest: 'abcdef0123456789'
    })
  })

  it.each([
    { op: 'grant', capability: 'stripe acme', reason: 'x', expected_digest: 'abcdef0123456789' },
    {
      op: 'grant',
      capability: 'stripe_acme.read',
      reason: '',
      expected_digest: 'abcdef0123456789'
    },
    { op: 'grant', capability: 'stripe_acme.read', reason: 'x', expected_digest: 'not-a-digest' },
    { op: 'grant', capability: 'stripe_acme.read', reason: 'x' },
    {
      op: 'deny',
      capability: 'stripe_acme.read',
      reason: 'x',
      expected_digest: 'abcdef0123456789',
      expires_at: 'x'
    },
    { op: 'remove', override_id: 'nope', expected_digest: 'abcdef0123456789' },
    {
      op: 'allow',
      capability: 'stripe_acme.read',
      reason: 'x',
      expected_digest: 'abcdef0123456789'
    }
  ])('refuses a malformed change (%o) before any request', async (change) => {
    const result = await client.change({
      ref: 'human:emp_shona',
      change: change as never
    })
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses `me` as the target of a change before any request', async () => {
    const result = await client.change({
      ref: 'me',
      change: {
        op: 'grant',
        capability: 'stripe_acme.read',
        reason: 'myself',
        expected_digest: 'abcdef0123456789'
      }
    })
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('pins an alias answer against the aliases the shelf reports', async () => {
    reply({
      ...shelf,
      principal: 'human:emp_sal',
      summary: { principal: 'human:emp_sal', aliases: ['sal'] }
    })
    const wrong = await client.person({ ref: 'shek' })
    expect(wrong.ok).toBe(false)
    reply({
      ...shelf,
      principal: 'human:emp_shona',
      summary: { principal: 'human:emp_shona', aliases: ['shona', 'shek'] }
    })
    const right = await client.person({ ref: 'shek' })
    expect(right.ok).toBe(true)
  })

  it('relays the console’s own refusal untouched', async () => {
    reply(
      { detail: 'Only the estate’s super admins may change access.', tag: 'access_admin_required' },
      403
    )
    const result = await client.change({
      ref: 'human:emp_shona',
      change: {
        op: 'grant',
        capability: 'stripe_acme.read',
        reason: 'let me in',
        expected_digest: 'abcdef0123456789'
      }
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('access_admin_required')
    expect(!result.ok && result.error.status).toBe(403)
  })
})

const sectionsPayload = {
  schema_version: 1,
  digest: 'abcdef0123456789',
  sections: [
    {
      key: 'finance',
      label: 'Finance',
      groups: ['payments'],
      read_ref: '@section:finance:read',
      write_ref: '@section:finance:write',
      read_count: 12,
      write_count: 7,
      floor_count: 3,
      capabilities: [
        {
          id: 'stripe_acme.read',
          label: 'Stripe — ACME (read)',
          connector: 'stripe_acme',
          group: 'payments',
          action_class: 'read_only',
          read_only: true,
          hard_denied: false
        }
      ]
    }
  ],
  templates: { everything: { label: 'Everything', sections: ['@section:finance:read'] } }
}

describe('the Tool Shelf sections contract', () => {
  it('reads the sections, their capabilities and the templates', async () => {
    reply(sectionsPayload)
    const result = await client.sections()
    expect(result.ok && result.data.sections[0].write_ref).toBe('@section:finance:write')
    expect(result.ok && result.data.sections[0].floor_count).toBe(3)
    expect(result.ok && result.data.templates.everything.label).toBe('Everything')
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/admin/access/sections')
    expect(init.method).toBe('GET')
  })

  it('refuses a section whose ref is not a section ref', async () => {
    reply({
      ...sectionsPayload,
      sections: [{ ...sectionsPayload.sections[0], read_ref: '../policy/grant' }]
    })
    const result = await client.sections()
    expect(result.ok).toBe(false)
  })
})

describe('the Tool Shelf bulk contract', () => {
  const answer = {
    digest: 'abcdef0123456789',
    dry_run: false,
    reason: 'quarterly review',
    changes: [
      {
        principal: 'human:emp_shona',
        action: 'deny',
        target: '@section:finance:write'
      }
    ],
    diff: [
      {
        principal: 'human:emp_shona',
        section: 'finance',
        target: '@section:finance:write',
        action: 'deny',
        before: { read: { granted: 12, total: 12 }, write: { granted: 7, total: 7, floor: 3 } },
        after: { read: { granted: 12, total: 12 }, write: { granted: 0, total: 7, floor: 3 } }
      }
    ],
    applied: [],
    removed: [],
    people: { digest: 'abcdef0123456789', principals: [], catalogue: { connectors: [] } }
  }

  it('sends a template change as a PATCH on the people collection', async () => {
    reply(answer)
    const result = await client.bulk({
      change: {
        reason: 'quarterly review',
        expected_digest: 'abcdef0123456789',
        template: 'customer-service',
        principals: ['human:emp_shona', 'human:emp_gamma']
      }
    })
    expect(result.ok && result.data.diff[0].section).toBe('finance')
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/admin/access/people')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({
      reason: 'quarterly review',
      expected_digest: 'abcdef0123456789',
      template: 'customer-service',
      principals: ['human:emp_shona', 'human:emp_gamma']
    })
  })

  it('sends a column change with no principals as the whole column', async () => {
    reply(answer)
    const result = await client.bulk({
      change: {
        reason: 'nobody writes to finance',
        expected_digest: 'abcdef0123456789',
        column: { section: 'finance', access: 'write', on: false }
      }
    })
    expect(result.ok).toBe(true)
    expect(JSON.parse(String(requested().init.body))).toEqual({
      reason: 'nobody writes to finance',
      expected_digest: 'abcdef0123456789',
      column: { section: 'finance', access: 'write', on: false }
    })
  })

  it('sends an imported grid as a dry run first', async () => {
    reply({ ...answer, dry_run: true })
    const result = await client.bulk({
      change: {
        reason: 'imported grid',
        expected_digest: 'abcdef0123456789',
        dry_run: true,
        changes: [
          {
            principal: 'human:emp_shona',
            action: 'grant',
            target: '@section:finance:read'
          },
          { principal: 'agent:luna-scout', action: 'remove', override_id: 'apl_abcd1234' }
        ]
      }
    })
    expect(result.ok && result.data.dry_run).toBe(true)
    expect(JSON.parse(String(requested().init.body)).dry_run).toBe(true)
  })

  it.each([
    {
      reason: 'x',
      expected_digest: 'abcdef0123456789',
      template: 'customer-service',
      principals: ['human:emp_shona'],
      column: { section: 'finance', access: 'read', on: true }
    },
    { reason: 'x', expected_digest: 'abcdef0123456789' },
    { reason: '', expected_digest: 'abcdef0123456789', changes: [] },
    {
      reason: 'x',
      expected_digest: 'abcdef0123456789',
      changes: [{ principal: 'me', action: 'grant', target: '@section:finance:read' }]
    },
    {
      reason: 'x',
      expected_digest: 'abcdef0123456789',
      changes: [
        { principal: 'human:emp_sal', action: 'grant', target: '@section:finance:sideways' }
      ]
    },
    {
      reason: 'x',
      expected_digest: 'abcdef0123456789',
      column: { section: 'finance', access: 'delete', on: true }
    },
    {
      reason: 'x',
      expected_digest: 'not-a-digest',
      template: 'customer-service',
      principals: ['human:emp_sal']
    }
  ])('refuses a malformed bulk change (%o) before any request', async (change) => {
    const result = await client.bulk({ change: change as never })
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('relays the hub’s digest conflict untouched', async () => {
    reply(
      { detail: 'The shelf changed while you were looking.', tag: 'access_settings_conflict' },
      409
    )
    const result = await client.bulk({
      change: {
        reason: 'quarterly review',
        expected_digest: 'abcdef0123456789',
        column: { section: 'finance', access: 'write', on: false }
      }
    })
    expect(!result.ok && result.error.code).toBe('access_settings_conflict')
    expect(!result.ok && result.error.status).toBe(409)
  })
})
