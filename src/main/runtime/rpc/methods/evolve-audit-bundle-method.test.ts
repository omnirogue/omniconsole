import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ show: vi.fn(), fetchBundle: vi.fn() }))
vi.mock('../../evolve/evolve-service-registry', () => ({
  getEvolveService: () => ({ show: mocks.show })
}))
vi.mock('../../evolve/evolve-audit-bundle-client', () => ({
  fetchEvolveAuditBundle: mocks.fetchBundle
}))

const { EVOLVE_METHODS } = await import('./evolve')
const method = EVOLVE_METHODS.find((entry) => entry.name === 'evolve.auditBundle')!
const id = 'evo_00000000-0000-4000-8000-000000000001'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('evolve.auditBundle', () => {
  it('reads the bundle for the record cloud run', async () => {
    mocks.show.mockReturnValue({ id, cloudRunId: 'cloud-run-1' })
    mocks.fetchBundle.mockResolvedValue({ format: 'omnisi-evolve/audit-bundle' })
    const params = method.params!.parse({ id })
    await expect(method.handler(params, { runtime: {} } as never)).resolves.toEqual({
      bundle: { format: 'omnisi-evolve/audit-bundle' }
    })
    expect(mocks.fetchBundle).toHaveBeenCalledWith('cloud-run-1')
  })

  it('refuses runs that were not hosted', async () => {
    mocks.show.mockReturnValue({ id })
    await expect(method.handler({ id }, { runtime: {} } as never)).rejects.toThrow(
      'Only hosted Evolve runs have an audit bundle.'
    )
    expect(mocks.fetchBundle).not.toHaveBeenCalled()
  })

  it('rejects ids that are not Evolve record ids', () => {
    expect(method.params!.safeParse({ id: '../cloud' }).success).toBe(false)
  })
})
