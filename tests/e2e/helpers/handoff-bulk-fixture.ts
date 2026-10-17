import type { ElectronApplication } from '@playwright/test'

/** Fixture state lives behind IPC so the tests assert the lists and receipts users see. */
export async function installBulkHandoffFixture(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const viewer = 'emp_sal'
    const threads = ['Alpha', 'Beta', 'Gamma'].map((name, index) => ({
      id: `hth_bulk${index}`,
      board_task_id: null,
      author_employee_id: index === 1 ? viewer : 'emp_colleague',
      recipient_employee_id: index === 1 ? 'emp_colleague' : viewer,
      title: `${name} handoff`,
      state: 'open',
      action: null,
      communication_type: 'information',
      due_at: null,
      parent_thread_id: null,
      delivery_id: null,
      updated: '2026-09-14T20:00:00Z',
      files: [],
      reviews: []
    }))
    const archived = new Set<string>()
    const ok = (data: unknown) => ({ ok: true, data })
    const register = (name: string, read: (args: unknown) => unknown) => {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, (_event, args) => read(args))
    }
    register('consoleCompanies:me', () =>
      ok({ ok: true, user: { employee_id: viewer, role: 'member' }, companies: [] })
    )
    register('consoleCompanies:folders', () => ok({ ok: true, companies: [] }))
    register('backoffice:listTodo', () => ({
      ok: true,
      baseUrl: 'https://fixture.test',
      employeeId: viewer,
      items: [],
      generatedAt: null,
      nextCursor: null
    }))
    register('consoleWorkflows:listHumanActions', () => ok({ jobs: [] }))
    register('consoleHandoffs:recipients', () =>
      ok({
        employees: [
          { id: viewer, name: 'Sal' },
          { id: 'emp_colleague', name: 'Colleague' }
        ]
      })
    )
    register('backoffice:feed', () => ({
      ok: true,
      body: { projects: [], people: [], threads: [] }
    }))
    register('consoleHandoffs:list', (args) => {
      const { view, state } = (args as { view?: string; state?: string } | undefined) ?? {}
      return ok({
        assignee: viewer,
        view: view ?? 'attention',
        threads: threads.filter((thread) =>
          view === 'archived'
            ? archived.has(thread.id)
            : !archived.has(thread.id) &&
              (state ? thread.state === state : view === 'sent' || thread.state !== 'resolved') &&
              (view === 'sent'
                ? thread.author_employee_id === viewer
                : thread.recipient_employee_id === viewer)
        )
      })
    })
    for (const name of ['get', 'markRead']) {
      register(`consoleHandoffs:${name}`, (args) => {
        const thread = threads.find((value) => value.id === (args as { threadId: string }).threadId)
        if (!thread) {
          throw new Error('Unexpected handoff fixture target.')
        }
        return ok({ thread, entries: [], reviews: [], files: [] })
      })
    }
    register('consoleHandoffs:archive', (args) => {
      const input = args as { threadId: string; archived: boolean; operationId: string }
      if (!input.operationId || !threads.some((thread) => thread.id === input.threadId)) {
        throw new Error('Archive must identify an exact handoff and saved operation.')
      }
      if (input.archived) {
        archived.add(input.threadId)
      } else {
        archived.delete(input.threadId)
      }
      return ok({ thread_id: input.threadId, employee_id: viewer, archived: input.archived })
    })
    register('consoleHandoffs:respond', (args) => {
      const input = args as { threadId: string; kind: string; operationId: string }
      const thread = threads.find((value) => value.id === input.threadId)
      if (!thread || input.kind !== 'done' || !input.operationId) {
        throw new Error('Completion must identify an exact handoff and saved operation.')
      }
      if (thread.id !== 'hth_bulk2') {
        thread.state = 'resolved'
      }
      return ok({ thread_id: input.threadId })
    })
  })
}
