import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { emptyNextStepDraft, type NextStepDraft } from '../../../../shared/next-step-draft'
import { createNextStepCard, ensureTaskForPeople } from './next-step-task-create'

const store = vi.hoisted(() => ({
  settings: {} as { experimentalCardlessHandoffs?: boolean },
  updateWorktreeMeta: vi.fn(async () => undefined),
  filing: vi.fn()
}))
// Why: where the card is filed is decided by the estate's folders; this test is about what
// the creator does with that answer.
vi.mock('./next-step-card-filing', () => ({ resolveNextStepCardFiling: store.filing }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: store.settings,
      getKnownWorktreeById: () => ({ path: '/w', linkedWorkItem: undefined }),
      updateWorktreeMeta: store.updateWorktreeMeta
    })
  }
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en' }
}))

const createTask = vi.fn()
const session = {
  rowKey: 'row',
  worktreeId: 'wt_1',
  hostId: 'local',
  paneKey: 'pane',
  label: 'Build landing page'
} as unknown as SidebarSession

function toPerson(): NextStepDraft {
  return {
    ...emptyNextStepDraft(),
    recipients: [{ kind: 'person', key: 'p1', id: 'emp_uma', name: 'Uma' }],
    note: 'Please look',
    handoff: { task: null, deliverables: null, includeSummary: true }
  }
}

beforeEach(() => {
  createTask.mockReset()
  store.filing.mockReset()
  store.filing.mockResolvedValue({
    filing: { companyId: 'cmp_click', unitId: 'dom_ads', goalId: 'cgl_q4' }
  })
  store.settings = {}
  vi.stubGlobal('window', { api: { backoffice: { createTask } } })
})

describe('createNextStepCard', () => {
  // Why: the hub refuses to dispatch a card without a goal, so the desktop files one at birth.
  it('files the new card under the company, department and goal it belongs to', async () => {
    createTask.mockResolvedValue({ ok: true, taskId: 'btk_new1', title: 'Build landing page' })
    const result = await createNextStepCard(session, 'Build landing page')
    expect(result).toEqual({ task: { id: 'btk_new1', title: 'Build landing page' } })
    expect(createTask.mock.calls[0]![0]).toMatchObject({
      title: 'Build landing page',
      companyId: 'cmp_click',
      unitId: 'dom_ads',
      goalId: 'cgl_q4'
    })
  })

  // Why: the fleet is the strict caller — the hub refuses to dispatch an unfiled card, so
  // creating one would leave a stray behind and still fail.
  it('creates nothing when the work cannot be filed, and says where to fix it', async () => {
    store.filing.mockResolvedValue({
      refusal: {
        reason: "Complete the task's company, goal and department before dispatching.",
        actionUrl: 'https://console.example.com/work'
      }
    })
    const result = await createNextStepCard(session, 'Build landing page')
    expect(createTask).not.toHaveBeenCalled()
    expect(result).toEqual({
      refusal: "Complete the task's company, goal and department before dispatching.",
      actionUrl: 'https://console.example.com/work'
    })
  })
})

describe('ensureTaskForPeople', () => {
  it.each([{}, { experimentalCardlessHandoffs: true }, { experimentalCardlessHandoffs: false }])(
    'creates no task with any cardless preferences: %j',
    async (settings) => {
      store.settings = settings
      const draft = toPerson()
      const result = await ensureTaskForPeople(session, draft)
      expect(createTask).not.toHaveBeenCalled()
      expect(result).toEqual({ draft })
    }
  )

  it.each([{}, { experimentalCardlessHandoffs: true }, { experimentalCardlessHandoffs: false }])(
    'preserves an existing task binding regardless of cardless preferences: %j',
    async (settings) => {
      store.settings = settings
      const draft = toPerson()
      draft.handoff.task = { id: 'btk_existing', title: 'Existing work' }
      expect(await ensureTaskForPeople(session, draft)).toEqual({ draft })
      expect(createTask).not.toHaveBeenCalled()
    }
  )
})
