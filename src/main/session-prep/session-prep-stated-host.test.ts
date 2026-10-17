import { describe, expect, it } from 'vitest'
import type { PlannedItem } from '../../shared/session-prep-types'
import { withStatedHost } from './session-prep-stated-host'

const repos = ['mw0001', 'mw0003'].map((host) => ({
  name: 'app',
  selector: host,
  host,
  hostAliases: [host]
}))
const item = (host?: string): PlannedItem => ({
  title: 'Audit',
  ask: 'Audit',
  anchor: 'audit',
  changesCode: false,
  direct: true,
  ...(host ? { choices: { host } } : {})
})

describe('stated session hosts', () => {
  it('refuses one host-less item naming two Macs, including a joined list', () => {
    for (const request of ['audit on mw0001 and mw0003', 'audit on mw0001 and on mw0003']) {
      expect(() => withStatedHost([item()], request, repos)).toThrow('No sessions launched')
      expect(() => withStatedHost([item('mw0001')], request, repos)).toThrow('No sessions launched')
    }
  })
  it('does not infer a host from a common label that the planner did not select', () => {
    expect(() =>
      withStatedHost([item()], 'fix it on dev', [{ name: 'app', selector: 'id:dev', host: 'dev' }])
    ).toThrow('No sessions launched')
  })
  it('keeps a complete explicit assignment and requests without host names', () => {
    const items = [item('mw0001'), item('mw0003')]
    expect(withStatedHost(items, 'audit on mw0001 and mw0003', repos)).toBe(items)
    expect(withStatedHost([item()], 'audit the code', repos)).toHaveLength(1)
  })
  it('does not interpret ordinary local work as an execution-host assignment', () => {
    const local = { name: 'app', selector: 'id:local', host: 'local', hostAliases: ['local'] }
    for (const request of ['fix the failing local tests', 'clean up the local dev server']) {
      const items = [item()]
      expect(withStatedHost(items, request, [local, ...repos])).toBe(items)
    }
  })
  it('still requires an explicit assignment when a remote source requests a local destination', () => {
    for (const host of ['local', 'this Mac', 'this computer']) {
      const request = `run this on ${host}`
      expect(() => withStatedHost([item()], request, repos)).toThrow('No sessions launched')
      expect(withStatedHost([item(host)], request, repos)).toHaveLength(1)
    }
    expect(() =>
      withStatedHost([item('mw0001')], 'run one on local and one on mw0001', repos)
    ).toThrow('No sessions launched')
  })
  it('accepts local wording when an unassigned item already inherits a local source', () => {
    for (const request of [
      'it works on local but fails in CI, fix it',
      'run the tests on local',
      'this depends on local state',
      'focus on local caching'
    ]) {
      const items = [item()]
      expect(withStatedHost(items, request, repos, 'local')).toBe(items)
      expect(() => withStatedHost(items, request, repos, 'ssh:worker')).toThrow(
        'No sessions launched'
      )
    }
  })
  it('keeps explicit assignments mandatory for mixed local and registered SSH destinations', () => {
    const request = 'run one on local and one on mw0001'
    expect(() => withStatedHost([item('mw0001')], request, repos, 'local')).toThrow(
      'No sessions launched'
    )
    expect(() => withStatedHost([item(), item('mw0001')], request, repos, 'local')).toThrow(
      'No sessions launched'
    )
    expect(withStatedHost([item('local'), item('mw0001')], request, repos, 'local')).toHaveLength(2)
    expect(() => withStatedHost([item()], 'run on mw0001', repos, 'local')).toThrow(
      'No sessions launched'
    )
  })
})
