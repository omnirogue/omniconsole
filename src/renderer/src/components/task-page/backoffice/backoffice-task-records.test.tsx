// @vitest-environment happy-dom
import type { SessionChain } from '../../../../../shared/session-chain-types'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackofficeTaskConversations, BackofficeTaskSessions } from './backoffice-task-records'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: Record<string, unknown>) =>
    vars
      ? Object.entries(vars).reduce(
          (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
          fallback
        )
      : fallback,
  i18n: { language: 'en' },
  getIntlLocale: () => 'en'
}))
const outcomeChains = vi.hoisted(() => ({
  rows: [] as SessionChain[]
}))
vi.mock('@/lib/session-chain-registry', () => ({ useShownSessionChains: () => outcomeChains.rows }))

const listWorkSessions = vi.hoisted(() => vi.fn())
const taskConversations = vi.hoisted(() => vi.fn())
vi.mock('@/lib/console-workflow-client', () => ({
  consoleWorkflowApi: () => ({ listWorkSessions, taskConversations }),
  workflowData: (result: { ok: boolean; data?: unknown; error?: { message: string } }) => {
    if (!result.ok) {
      throw new Error(result.error?.message ?? 'failed')
    }
    return result.data
  },
  workflowErrorMessage: (reason: unknown) =>
    reason instanceof Error ? reason.message : String(reason)
}))

afterEach(cleanup)

describe('BackofficeTaskSessions attach button', () => {
  it('shows Attach on every unlinked session row, without needing the toggle first', async () => {
    listWorkSessions.mockResolvedValue({
      ok: true,
      data: {
        sessions: [
          { id: 'ses_linked', task_title: 'On this task', board_task_id: 'btk_this' },
          { id: 'ses_loose', task_title: 'Not yet on any task', board_task_id: null }
        ]
      }
    })
    render(<BackofficeTaskSessions taskId="btk_this" baseUrl={null} />)
    // "Inspect unlinked sessions" still selects the wider, system-wide unlinked listing.
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect unlinked sessions' }))
    const row = (await screen.findByText('Not yet on any task')).closest('li')!
    expect(within(row).getByRole('button', { name: 'Link this session to this task' })).toBeTruthy()
  })

  it('never shows Attach on a row already linked to a task', async () => {
    listWorkSessions.mockResolvedValue({
      ok: true,
      data: {
        sessions: [{ id: 'ses_linked', task_title: 'On this task', board_task_id: 'btk_this' }]
      }
    })
    render(<BackofficeTaskSessions taskId="btk_this" baseUrl={null} />)
    await screen.findByText('On this task')
    expect(screen.queryByRole('button', { name: 'Link this session to this task' })).toBeNull()
  })
})

describe('BackofficeTaskConversations', () => {
  it('renders every attached conversation with its agent, state and activity', async () => {
    taskConversations.mockResolvedValue({
      ok: true,
      data: {
        overflow: 0,
        rows: [
          {
            ledgerId: 'als_0123456789abcdef01234567',
            employeeName: 'Sal',
            agent: 'claude',
            model: 'opus',
            state: 'running',
            lastActivityAt: new Date().toISOString(),
            lastAction: null,
            activitySummary: { edits: 3, commits: 1 }
          },
          {
            ledgerId: 'als_0123456789abcdef01234568',
            employeeName: null,
            agent: null,
            model: null,
            state: 'waiting',
            lastActivityAt: new Date().toISOString(),
            lastAction: { kind: 'tool_call', target: 'read src/entry.ts' },
            activitySummary: null
          }
        ]
      }
    })
    render(<BackofficeTaskConversations taskId="btk_this" />)
    expect(await screen.findByText('Conversations (2)')).toBeTruthy()
    expect(screen.getByText('3 edits · 1 commits')).toBeTruthy()
    expect(screen.getByText('read src/entry.ts')).toBeTruthy()
    expect(screen.getByText('Unknown person · Waiting', { exact: false })).toBeTruthy()
  })

  it('shows a "+N more" note only when the console reports an overflow', async () => {
    taskConversations.mockResolvedValue({
      ok: true,
      data: {
        overflow: 4,
        rows: [
          {
            ledgerId: 'als_0123456789abcdef01234569',
            employeeName: 'Sal',
            agent: 'claude',
            model: 'opus',
            state: 'running',
            lastActivityAt: new Date().toISOString(),
            lastAction: null,
            activitySummary: null
          }
        ]
      }
    })
    render(<BackofficeTaskConversations taskId="btk_this" />)
    expect(await screen.findByText('Conversations (1) (+4 more)')).toBeTruthy()
  })

  it('shows the empty state when no conversation is attached', async () => {
    taskConversations.mockResolvedValue({ ok: true, data: { overflow: 0, rows: [] } })
    render(<BackofficeTaskConversations taskId="btk_this" />)
    expect(
      await screen.findByText(
        'No conversations attached yet. Use Add to a task from a conversation.'
      )
    ).toBeTruthy()
  })

  it('reports an honest error instead of a silent empty list', async () => {
    taskConversations.mockResolvedValue({
      ok: false,
      error: { code: 'backoffice_unavailable', message: 'The backoffice could not be reached.' }
    })
    render(<BackofficeTaskConversations taskId="btk_this" />)
    expect(
      await screen.findByText('Conversations unavailable: The backoffice could not be reached.', {
        exact: false
      })
    ).toBeTruthy()
  })
})

it('shows receipt-backed outcome rows beside conversations without creating rows for ordinary chats', async () => {
  const { planReportChain } =
    await import('../../../../../shared/__fixtures__/work-plan/plan-report-chain')
  const { sessionOutcomeConditionKey } = await import('../../../../../shared/session-outcome-types')
  const chain = planReportChain()
  const outcome = chain.outcomeSet!.outcomes[0]!
  outcome.taskRef = { taskId: 'btk_this', attachedAt: 1 }
  outcome.evidence[0]!.conditionKey = sessionOutcomeConditionKey(outcome.conditions[0]!)
  const chat = { ...chain, id: 'chat', outcomeSet: undefined }
  outcomeChains.rows = [chain, chat]
  taskConversations.mockResolvedValue({ ok: true, data: { rows: [], overflow: 0 } })
  try {
    render(<BackofficeTaskConversations taskId="btk_this" />)
    const outcomes = screen.getByRole('region', { name: 'Outcomes' })
    expect(within(outcomes).getAllByRole('listitem')).toHaveLength(1)
    expect(within(outcomes).getByText(/Ship the launch page · 1\/2 done-when/)).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Conversations' })).toBeTruthy()
    await screen.findByText('No conversations attached yet. Use Add to a task from a conversation.')
  } finally {
    outcomeChains.rows = []
  }
})
