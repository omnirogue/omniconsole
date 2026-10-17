import { describe, expect, it, vi } from 'vitest'
import type { TeamMemoryStatus } from '../../shared/team-memory-contract'
import { TeamMemoryStatusService } from './team-memory-status-service'

function harness(args: {
  signedIn?: boolean
  answer:
    | { ok: true; data: TeamMemoryStatus }
    | { ok: false; error: { code: string; message: string } }
}) {
  const reportHealth = vi.fn()
  const publish = vi.fn()
  const service = new TeamMemoryStatusService({
    isSignedIn: () => args.signedIn ?? true,
    fetchStatus: vi.fn(async () => args.answer),
    reportHealth,
    publish,
    now: () => 5_000
  })
  return { service, reportHealth, publish }
}

const loaded: TeamMemoryStatus = {
  employee_id: 'emp_shona',
  rendered_bytes: 3_000,
  index_over_budget: false,
  everyone: { revision: 3, bytes: 900, updated_at: null },
  personal: { revision: 1, bytes: 200, updated_at: null },
  loaded_in_connector: true
}

describe('TeamMemoryStatusService', () => {
  it('starts unknown, then maps a loaded answer with both revisions and reports ok', async () => {
    const { service, reportHealth, publish } = harness({ answer: { ok: true, data: loaded } })
    expect(service.status()).toEqual({ state: 'unknown' })
    await service.refresh()
    expect(service.status()).toEqual({
      state: 'loaded',
      everyoneRevision: 3,
      personalRevision: 1,
      indexOverBudget: false,
      checkedAt: 5_000
    })
    expect(publish).toHaveBeenCalledWith(service.status())
    expect(reportHealth).toHaveBeenCalledWith({
      feature: 'team_memory',
      status: 'ok',
      message: 'everyone r3 personal r1'
    })
  })

  it('carries index_over_budget into the view and the health code', async () => {
    const { service, reportHealth } = harness({
      answer: { ok: true, data: { ...loaded, index_over_budget: true, personal: null } }
    })
    await service.refresh()
    expect(service.status()).toMatchObject({
      state: 'loaded',
      personalRevision: null,
      indexOverBudget: true
    })
    expect(reportHealth).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'team_memory', status: 'ok', code: 'index_over_budget' })
    )
  })

  it('names why memory is not loaded: signed out, no employee, not in connector, request failed', async () => {
    const signedOut = harness({ signedIn: false, answer: { ok: true, data: loaded } })
    await signedOut.service.refresh()
    expect(signedOut.service.status()).toMatchObject({
      state: 'not_loaded',
      reason: 'not_signed_in'
    })
    expect(signedOut.reportHealth).not.toHaveBeenCalled()

    const noEmployee = harness({ answer: { ok: true, data: { ...loaded, employee_id: null } } })
    await noEmployee.service.refresh()
    expect(noEmployee.service.status()).toMatchObject({ reason: 'no_employee_mapping' })

    // An omitted employee_id is the same fact, not "loaded".
    const { employee_id: _omitted, ...withoutEmployee } = loaded
    const omitted = harness({ answer: { ok: true, data: withoutEmployee } })
    await omitted.service.refresh()
    expect(omitted.service.status()).toMatchObject({ reason: 'no_employee_mapping' })
    expect(noEmployee.reportHealth).toHaveBeenCalledWith({
      feature: 'team_memory',
      status: 'error',
      code: 'no_employee_mapping'
    })

    const notLoaded = harness({
      answer: { ok: true, data: { ...loaded, loaded_in_connector: false } }
    })
    await notLoaded.service.refresh()
    expect(notLoaded.service.status()).toMatchObject({ reason: 'not_loaded' })

    const refused = harness({
      answer: { ok: false, error: { code: 'no-employee-mapping', message: 'none' } }
    })
    await refused.service.refresh()
    expect(refused.service.status()).toMatchObject({ reason: 'no_employee_mapping' })

    const down = harness({
      answer: { ok: false, error: { code: 'backoffice_unavailable', message: 'down' } }
    })
    await down.service.refresh()
    expect(down.service.status()).toMatchObject({ reason: 'request_failed' })
  })

  it('coalesces concurrent refreshes into one request', async () => {
    const fetchStatus = vi.fn(async () => ({ ok: true as const, data: loaded }))
    const service = new TeamMemoryStatusService({
      isSignedIn: () => true,
      fetchStatus,
      reportHealth: vi.fn(),
      publish: vi.fn()
    })
    await Promise.all([service.refresh(), service.refresh()])
    expect(fetchStatus).toHaveBeenCalledTimes(1)
  })
})
