import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBackofficeTask } from './backoffice-task-create'
import { currentBearerToken } from './backoffice-auth'
import { getBackofficeSnapshot } from './backoffice-config'

vi.mock('./backoffice-auth', () => ({ currentBearerToken: vi.fn() }))
vi.mock('./backoffice-config', () => ({ getBackofficeSnapshot: vi.fn() }))
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: async () => {
    const bearer = await currentBearerToken()
    return bearer
      ? {
          ok: true,
          data: {
            bearer,
            baseUrl: 'https://omnios.example.com',
            principal: 'a'.repeat(64),
            isCurrent: () => true
          }
        }
      : { ok: false, error: { code: 'signed_out', message: 'Sign in first.' } }
  }
}))

const CONFIGURED = { configured: true as const, baseUrl: 'https://omnios.example.com', message: '' }

describe('createBackofficeTask', () => {
  beforeEach(() => {
    vi.mocked(getBackofficeSnapshot).mockReturnValue(CONFIGURED as never)
    vi.mocked(currentBearerToken).mockResolvedValue('signed-person-token')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('posts a capture card with the IDE source and reads the created id', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'btk_0a1b2c3d' }), { status: 201 })
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      createBackofficeTask({ title: '  Fix the login page ', description: 'From session Codex' })
    ).resolves.toEqual({
      ok: true,
      taskId: 'btk_0a1b2c3d',
      title: 'Fix the login page',
      principal: 'a'.repeat(64)
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://omnios.example.com/api/collab/board')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(JSON.parse(init.body as string)).toEqual({
      title: 'Fix the login page',
      card_class: 'CAPTURE',
      source: 'omniconsole-ide',
      description: 'From session Codex'
    })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer signed-person-token')
  })

  it('accepts the nested spellings the hub uses for the created row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ task: { id: 'btk_9f9f9f9f' } }), { status: 201 })
      )
    )
    await expect(createBackofficeTask({ title: 'T' })).resolves.toMatchObject({
      ok: true,
      taskId: 'btk_9f9f9f9f'
    })
  })

  it('names the sender as the card custodian when their employee id is known', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ task_id: 'btk_0a1b2c3d' }), { status: 201 })
    )
    vi.stubGlobal('fetch', fetchMock)
    await createBackofficeTask({ title: 'T', ownerEmployeeId: 'emp_sal' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ owner_employee_id: 'emp_sal' })
  })

  it('reads the id out of the console envelope a delegated write answers with', async () => {
    // Why: measured live 2026-09-11 — the console answers {ok, status, payload: <row>}; the
    // person handoff was refused after the card had been created.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              status: 201,
              payload: { task_id: 'btk_e1e2e3e4', status: 'open' },
              actor: 'sal'
            }),
            { status: 200 }
          )
      )
    )
    await expect(createBackofficeTask({ title: 'T' })).resolves.toMatchObject({
      ok: true,
      taskId: 'btk_e1e2e3e4'
    })
  })

  it('tags a proposal and its extra companies on the created card, naming the revision', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: 'btk_0a1b2c3d', state_revision: 3 }), {
          status: 201
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      createBackofficeTask({
        title: 'Unlimited toggle',
        companyId: 'co_betacorp',
        companySlug: 'betacorp',
        additionalCompanySlugs: ['OmniRogue', 'betacorp'],
        proposed: true
      })
    ).resolves.toEqual({
      ok: true,
      taskId: 'btk_0a1b2c3d',
      title: 'Unlimited toggle',
      principal: 'a'.repeat(64),
      tagsApplied: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe('https://omnios.example.com/api/collab/board/btk_0a1b2c3d')
    expect(init).toMatchObject({ method: 'PATCH', redirect: 'error' })
    expect(JSON.parse(String(init.body))).toEqual({
      expected_revision: 3,
      tags: ['proposed', 'company:omnirogue']
    })
    expect(
      JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    ).toHaveProperty('tags', ['proposed', 'company:omnirogue'])
  })

  it('keeps the created card and says so when the tag write is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ task_id: 'btk_0a1b2c3d', state_revision: 1 }), {
            status: 201
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ detail: "unknown fields: ['tags']" }), { status: 400 })
        )
    )
    await expect(createBackofficeTask({ title: 'Idea', proposed: true })).resolves.toMatchObject({
      ok: true,
      taskId: 'btk_0a1b2c3d',
      tagsApplied: false,
      warning: expect.stringContaining("unknown fields: ['tags']")
    })
  })

  it('names a company whose slug does not fit a tag instead of dropping it in silence', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: 'btk_0a1b2c3d', state_revision: 1 }), {
          status: 201
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const long = 'y'.repeat(40)
    await expect(
      createBackofficeTask({
        title: 'T',
        companySlug: 'alpha',
        additionalCompanySlugs: ['beta', long]
      })
    ).resolves.toMatchObject({
      ok: true,
      tagsApplied: true,
      warning: expect.stringContaining(long)
    })
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ expected_revision: 1, tags: ['company:beta'] })
  })

  it('writes no tags for an ordinary single-company card', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ task_id: 'btk_0a1b2c3d' }), { status: 201 })
    )
    vi.stubGlobal('fetch', fetchMock)
    await createBackofficeTask({ title: 'T', companyId: 'co_1', companySlug: 'alpha' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses without a title, without a session, and relays a hub refusal', async () => {
    await expect(createBackofficeTask({ title: '   ' })).resolves.toEqual({
      ok: false,
      message: 'A new task needs a title.'
    })
    vi.mocked(currentBearerToken).mockResolvedValueOnce(null as never)
    await expect(createBackofficeTask({ title: 'T' })).resolves.toMatchObject({ ok: false })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: 'title too long' }), { status: 422 }))
    )
    await expect(createBackofficeTask({ title: 'T' })).resolves.toEqual({
      ok: false,
      message: 'title too long'
    })
  })

  it('says when the hub created the card but did not answer with an id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 201 }))
    )
    await expect(createBackofficeTask({ title: 'T' })).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('without its id')
    })
  })

  it('files the card where the work belongs and names everyone on it', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'btk_filed0001' }), { status: 201 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await createBackofficeTask({
      title: 'Simplify handoffs',
      ownerEmployeeId: 'emp_sal',
      companyId: 'co_2302606a8a46474e8311',
      unitId: 'org_cc669a9023a24ed8984e',
      projectId: 'proj_16f783f7964e4c08a14c',
      actorIds: ['emp_sal', 'emp_uma', 'emp_sal', '  ', 'not a valid id!']
    })
    expect(result).toMatchObject({ ok: true, taskId: 'btk_filed0001' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      title: 'Simplify handoffs',
      card_class: 'CAPTURE',
      source: 'omniconsole-ide',
      owner_employee_id: 'emp_sal',
      org_company_id: 'co_2302606a8a46474e8311',
      org_unit_id: 'org_cc669a9023a24ed8984e',
      project_id: 'proj_16f783f7964e4c08a14c',
      actors: ['emp_sal', 'emp_uma']
    })
  })

  it('leaves the filing keys out entirely when it does not know the place', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'btk_unfiled01' }), { status: 201 })
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await createBackofficeTask({ title: 'Quick capture' })).toMatchObject({ ok: true })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(Object.keys(body).sort()).toEqual(['card_class', 'source', 'title'])
  })

  it('sends the optional shared brief, planned steps, due date and priority', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'btk_brief001' }), { status: 201 })
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(
      await createBackofficeTask({
        title: 'Prepare launch',
        description: 'Use the shared brief',
        dueDate: '2026-09-30',
        priority: 'high',
        sequentialSteps: [' Draft with AI ', 'Sal reviews']
      })
    ).toMatchObject({ ok: true })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({
      description: 'Use the shared brief',
      due_date: '2026-09-30',
      priority: 'high',
      sequential_steps: ['Draft with AI', 'Sal reviews']
    })
  })

  it('refuses invalid or oversized optional fields before creating a task', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const invalid of [
      { description: 'x'.repeat(8001) },
      { priority: 'highest' },
      { dueDate: 'tomorrow' },
      { sequentialSteps: ['   '] },
      { sequentialSteps: Array(101).fill('Step') }
    ]) {
      expect(await createBackofficeTask({ title: 'T', ...invalid })).toMatchObject({ ok: false })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates a structured plan and desired outcome through the existing task authority', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: 'btk_outcome01' }), { status: 201 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const plan = {
      version: 1 as const,
      steps: [{ id: 'review', title: 'Review work', actor_ids: ['emp_gamma'] }],
      completion_mode: 'deployment' as const,
      deployment_target: 'Staging'
    }
    expect(
      await createBackofficeTask({
        title: 'Ship release',
        taskPlan: plan,
        acceptanceCriteria: 'Verified staging release'
      })
    ).toMatchObject({ ok: true })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({
      acceptance_criteria: 'Verified staging release',
      task_plan: plan
    })
  })
})

it('saves proposal tags atomically without a second write when the hub returns them', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        task: {
          id: 'btk_atomic',
          state_revision: 1,
          tags: ['proposed', 'company:omnirogue']
        }
      }),
      { status: 201 }
    )
  )
  vi.stubGlobal('fetch', fetchMock)
  const result = await createBackofficeTask({
    title: 'Idea',
    proposed: true,
    additionalCompanySlugs: ['omnirogue']
  })
  expect(result).toMatchObject({ ok: true, taskId: 'btk_atomic', tagsApplied: true })
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).tags).toEqual([
    'proposed',
    'company:omnirogue'
  ])
})

it('uses the compatibility create only after an explicit unknown-tags validation refusal', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "card contains unknown fields: ['tags']" }), {
        status: 400
      })
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'btk_legacy', state_revision: 1 }), { status: 201 })
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  expect(await createBackofficeTask({ title: 'Idea', proposed: true })).toMatchObject({
    ok: true,
    taskId: 'btk_legacy'
  })
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('tags')
  expect(fetchMock.mock.calls[2][1].method).toBe('PATCH')
})

it.each([undefined, -1, 1.5])(
  'keeps the created card without an unchecked tag repair for revision %s',
  async (state_revision) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'btk_norevision', state_revision }), { status: 201 })
      )
    vi.stubGlobal('fetch', fetchMock)
    const result = await createBackofficeTask({ title: 'Idea', proposed: true })
    expect(result).toMatchObject({
      ok: true,
      taskId: 'btk_norevision',
      tagsApplied: false,
      warning: expect.stringContaining('no revision')
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  }
)
