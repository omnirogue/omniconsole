import type { NextStepSubject } from './next-step-subject'
// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CompaniesClient from '@/components/companies/companies-client'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import type { WorkAgentStatus } from '../../../../shared/work-agent-availability'
import { resetHandoffPeopleReads } from './use-handoff-people'
import { useNextStepRecipients } from './use-next-step-recipients'

const claudeRates = {
  claude: {
    provider: 'claude',
    status: 'ok',
    updatedAt: 1,
    error: null,
    session: {
      usedPercent: 100,
      resetDescription: 'tomorrow',
      resetsAt: null,
      windowMinutes: 300
    },
    weekly: null
  }
} as unknown as RateLimitState
const mocks = vi.hoisted(() => ({
  recipients: vi.fn(),
  capabilityCalls: vi.fn(),
  me: vi.fn(),
  refreshCapabilities: vi.fn(),
  reloadFolders: vi.fn(),
  statuses: { claude: 'quota-exhausted', aider: 'usable' } as Record<string, string>,
  rates: null as RateLimitState | null
}))
vi.mock('@/hooks/useWorkAgentCapabilities', async () => {
  const capabilities = () =>
    ['claude', 'aider'].map((id) => ({
      id,
      label: id,
      status: (mocks.statuses[id] ?? 'usable') as WorkAgentStatus,
      models: [],
      checkedAt: 1
    }))
  return {
    // Why: the canonical availability projection; this hook only layers reasons and usage on it.
    useWorkAgentCapabilities: (...args: unknown[]) => {
      mocks.capabilityCalls(...args)
      return {
        capabilities: capabilities(),
        usable: capabilities().filter((entry) => entry.status === 'usable'),
        rates: mocks.rates,
        loading: false,
        refresh: async () => {
          mocks.refreshCapabilities()
          return capabilities()
        }
      }
    },
    workAgentProviderUsage: (state: RateLimitState, agent: string) =>
      (state as unknown as Record<string, unknown>)[agent] ?? null
  }
})
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => 'account' }))
vi.mock('@/components/handoffs/handoff-client', () => ({
  handoffApi: () => ({ recipients: mocks.recipients })
}))
vi.mock('@/components/companies/companies-client', async (importOriginal) => ({
  ...(await importOriginal<typeof CompaniesClient>()),
  companiesApi: () => ({ me: mocks.me })
}))
vi.mock('@/components/companies/use-work-folders', () => ({
  useWorkFolders: () => ({
    data: { companies: [] },
    error: null,
    loading: false,
    reload: mocks.reloadFolders
  })
}))
const subject = {
  kind: 'session',
  session: {
    worktreeId: 'folder-workspace',
    label: 'Work',
    hostId: 'local',
    paneKey: null,
    sessionKey: null
  }
} as NextStepSubject
beforeEach(() => {
  resetHandoffPeopleReads()
  vi.clearAllMocks()
  mocks.statuses = { claude: 'quota-exhausted', aider: 'usable' }
  mocks.rates = claudeRates
  mocks.me.mockResolvedValue({
    ok: true,
    data: { user: { employee_id: 'emp_self' }, company_scope: 'all' }
  })
  mocks.recipients.mockResolvedValue({
    ok: true,
    data: {
      employees: [
        { id: 'emp_self', name: 'Self' },
        { id: 'emp_other', name: 'Other' }
      ],
      peopleSource: 'directory'
    }
  })
})
describe('next step recipients composition', () => {
  it('exposes usage details, hidden reasons, scoped people and both refresh operations', async () => {
    const { result } = renderHook(() => useNextStepRecipients(subject))
    await waitFor(() => expect(result.current.people.phase).toBe('ready'))
    expect(result.current.agents).toMatchObject({ phase: 'ready', value: [{ id: 'aider' }] })
    expect(result.current.agentDetails.get('claude')).toEqual({
      usedPercent: 100,
      windowKind: 'session',
      windowLabel: '5 h',
      resetDescription: 'tomorrow'
    })
    expect(result.current.hiddenAgents).toEqual([
      {
        id: 'claude',
        label: 'claude',
        code: 'out-of-quota',
        reset: 'tomorrow',
        reason: 'out of quota until tomorrow'
      }
    ])
    expect(result.current.people).toEqual({
      phase: 'ready',
      value: [
        { id: 'emp_self', name: 'Self' },
        { id: 'emp_other', name: 'Other' }
      ]
    })
    expect(result.current.peopleSource).toBe('directory')
    await act(() => result.current.refreshAgents())
    expect(mocks.refreshCapabilities).toHaveBeenCalledTimes(1)
    act(() => result.current.reload())
    await waitFor(() => expect(mocks.recipients).toHaveBeenCalledTimes(2))
    expect(mocks.reloadFolders).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['cli-missing', 'not-installed', 'not installed on this host'],
    ['disabled', 'disabled', 'disabled in Settings → Agents'],
    ['logged-out', 'not-signed-in', 'not signed in'],
    ['health-check-failed', 'health-check-failed', 'its account check failed'],
    ['model-unavailable', 'model-unavailable', 'no model of its own is available'],
    ['unverified', 'unverified', 'its sign-in and quota could not be checked']
  ] as const)(
    'says in plain language why a %s agent is not offered',
    async (status, code, reason) => {
      mocks.statuses = { claude: status, aider: 'usable' }
      const { result } = renderHook(() => useNextStepRecipients(subject))
      await waitFor(() => expect(result.current.people.phase).toBe('ready'))
      expect(result.current.hiddenAgents).toMatchObject([{ id: 'claude', code, reason }])
      expect(result.current.agents).toMatchObject({ phase: 'ready', value: [{ id: 'aider' }] })
    }
  )
  it('refuses the whole picker when the work location needs an approved work plan', async () => {
    mocks.statuses = { claude: 'work-plan-required', aider: 'work-plan-required' }
    const { result } = renderHook(() => useNextStepRecipients(subject))
    await waitFor(() => expect(result.current.people.phase).toBe('ready'))
    expect(result.current.agents.phase).toBe('error')
    // Why: this is the panel's refusal, not one agent being unavailable.
    expect(result.current.hiddenAgents).toEqual([])
  })
  it('accepts the main-process employees fallback and older responses without source metadata', async () => {
    mocks.recipients.mockResolvedValue({
      ok: true,
      data: { employees: [{ id: 'emp_other', name: 'Other' }] }
    })
    const { result } = renderHook(() => useNextStepRecipients(subject))
    await waitFor(() => expect(result.current.people.phase).toBe('ready'))
    expect(result.current.peopleSource).toBe('employees')
  })
  it('withholds the roster without a Me employee mapping: no sender identity, no handoff target', async () => {
    // Why: a console user with no employee mapping cannot be identified as a handoff
    // sender; the hub would reject any person-send with no explanation client-side.
    mocks.me.mockResolvedValue({
      ok: true,
      data: { user: { employee_id: null }, company_scope: 'all' }
    })
    const { result } = renderHook(() => useNextStepRecipients(subject))
    await waitFor(() =>
      expect(result.current.people).toMatchObject({
        phase: 'error',
        message: expect.stringContaining('employee profile')
      })
    )
    mocks.me.mockResolvedValue({
      ok: true,
      data: { user: { employee_id: 'emp_self' }, company_scope: 'all' }
    })
    act(() => result.current.reload())
    await waitFor(() =>
      expect(result.current.people).toMatchObject({
        phase: 'ready',
        value: [{ id: 'emp_self' }, { id: 'emp_other' }]
      })
    )
  })
  it('surfaces an unavailable roster when neither route is served', async () => {
    mocks.recipients.mockResolvedValue({
      ok: false,
      error: { code: 'capability_unavailable', message: 'Not served', status: 404 }
    })
    const { result } = renderHook(() => useNextStepRecipients(subject))
    await waitFor(() =>
      expect(result.current.people).toEqual({ phase: 'error', message: 'Not served' })
    )
  })
  it('does not apply another host’s quota to an SSH workspace', async () => {
    // Why: the capability hook hands back no usage for a remote host; nothing may be inferred.
    mocks.rates = null
    const { result } = renderHook(() => useNextStepRecipients(subject))
    await waitFor(() => expect(result.current.people.phase).toBe('ready'))
    expect(result.current.agentDetails.get('claude')?.usedPercent).toBeNull()
    expect(result.current.hiddenAgents).toMatchObject([{ id: 'claude', reset: null }])
  })
})

it('negotiates continuation for Next actions whose task comes from the workspace rather than the subject', () => {
  renderHook(() => useNextStepRecipients(subject))
  expect(mocks.capabilityCalls).toHaveBeenCalledWith(
    'folder-workspace',
    undefined,
    'task-continuation'
  )
})
