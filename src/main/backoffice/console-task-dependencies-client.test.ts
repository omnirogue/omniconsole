import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleTaskDependenciesClient as client } from './console-task-dependencies-client'
import { consoleWorkflowClient } from './console-workflow-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { routes } from './console-workflow-routes'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  getConsolePublicationPrincipal: vi.fn(),
  sanitizeConsoleWorkflowText: (value: string) => value,
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
}
function requested(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return { url, init }
}
const base = 'https://console.test/api/gtd/hub/api/collab/board'
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'test-person-only',
      baseUrl: 'https://console.test',
      principal: 'test-person',
      isCurrent: () => true
    }
  } as never)
})

describe('task dependency routes', () => {
  const allowed = (method: keyof typeof routes, path: string) =>
    routes[method].some((route) => route.test.test(path))

  it('allows exactly the three dependency shapes', () => {
    expect(allowed('GET', '/api/gtd/hub/api/collab/board/btk_card0001/deps')).toBe(true)
    expect(allowed('POST', '/api/gtd/hub/api/collab/board/btk_card0001/deps')).toBe(true)
    expect(allowed('DELETE', '/api/gtd/hub/api/collab/board/btk_card0001/deps/btk_prereq01')).toBe(
      true
    )
    for (const path of [
      '/api/gtd/hub/api/collab/board/btk_card0001/deps?all=1',
      '/api/gtd/hub/api/collab/board/card0001/deps',
      '/api/gtd/hub/api/collab/board/btk_card0001/deps/btk_prereq01/extra',
      '/api/gtd/hub/api/collab/board/btk_card0001/deps/../btk_x'
    ]) {
      expect(allowed('GET', path) || allowed('POST', path) || allowed('DELETE', path)).toBe(false)
    }
    expect(allowed('DELETE', '/api/gtd/hub/api/collab/board/btk_card0001/deps')).toBe(false)
    expect(allowed('GET', '/api/gtd/hub/api/collab/board/btk_card0001/deps/btk_prereq01')).toBe(
      false
    )
  })

  it('is advertised as available by the workflow client', async () => {
    const caps = await consoleWorkflowClient.capabilities()
    expect(caps.ok && caps.data.listTaskDependencies.available).toBe(true)
    expect(caps.ok && caps.data.removeTaskDependency.available).toBe(true)
  })
})

describe('task dependency client', () => {
  it('reads the graph for the task it asked about', async () => {
    reply({ task_id: 'btk_card0001', depends_on: [], dependents: [] })
    const result = await client.listTaskDependencies({ taskId: 'btk_card0001' })
    expect(result).toMatchObject({ ok: true, data: { depends_on: [] } })
    expect(requested().url).toBe(`${base}/btk_card0001/deps`)
    expect(requested().init.method).toBe('GET')
  })

  it('refuses a graph answered for a different task', async () => {
    reply({ task_id: 'btk_other001', depends_on: [], dependents: [] })
    const result = await client.listTaskDependencies({ taskId: 'btk_card0001' })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
  })

  it('adds an edge with the exact body and returns the edge', async () => {
    reply({
      task_id: 'btk_card0001',
      depends_on_task_id: 'btk_prereq01',
      condition: 'DONE',
      created_by: 'emp_sal',
      state: 'waiting',
      reason: null,
      edge: {
        task_id: 'btk_prereq01',
        title: 'Prep',
        status: 'ready',
        condition: 'DONE',
        state: 'waiting',
        reason: null,
        created_by: 'emp_sal'
      }
    })
    const result = await client.addTaskDependency({
      taskId: 'btk_card0001',
      dependsOnTaskId: 'btk_prereq01'
    })
    expect(result).toMatchObject({ ok: true, data: { task_id: 'btk_prereq01', title: 'Prep' } })
    expect(requested().url).toBe(`${base}/btk_card0001/deps`)
    expect(requested().init.method).toBe('POST')
    expect(JSON.parse(String(requested().init.body))).toEqual({
      depends_on_task_id: 'btk_prereq01',
      condition: 'DONE'
    })
  })

  it('never sends a self-dependency', async () => {
    const result = await client.addTaskDependency({
      taskId: 'btk_card0001',
      dependsOnTaskId: 'btk_card0001'
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the hub refusal code and status so the page can explain it', async () => {
    reply({ detail: { code: 'dependency_cycle', message: 'cycle' } }, 400)
    const cycle = await client.addTaskDependency({
      taskId: 'btk_card0001',
      dependsOnTaskId: 'btk_prereq01'
    })
    expect(cycle).toMatchObject({ ok: false, error: { code: 'dependency_cycle', status: 400 } })
    reply({ error: { code: 'card-not-ours', message: 'not ours' } }, 409)
    const other = await client.removeTaskDependency({
      taskId: 'btk_card0001',
      dependsOnTaskId: 'btk_prereq01'
    })
    expect(other).toMatchObject({ ok: false, error: { code: 'card-not-ours', status: 409 } })
  })

  it('removes an edge with DELETE and no body', async () => {
    reply({ removed: false })
    const result = await client.removeTaskDependency({
      taskId: 'btk_card0001',
      dependsOnTaskId: 'btk_prereq01'
    })
    expect(result).toEqual({ ok: true, data: { removed: false } })
    expect(requested().url).toBe(`${base}/btk_card0001/deps/btk_prereq01`)
    expect(requested().init.method).toBe('DELETE')
    expect(requested().init.body).toBeUndefined()
  })
})
