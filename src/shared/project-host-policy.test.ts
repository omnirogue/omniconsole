import { describe, expect, it } from 'vitest'
import { pickProjectHost, projectHostsInOrder } from './project-host-policy'

describe('projectHostsInOrder', () => {
  it('chooses nothing for auto and as-named', () => {
    expect(projectHostsInOrder('auto')).toEqual([])
    expect(projectHostsInOrder('as-named')).toEqual([])
    expect(projectHostsInOrder(undefined)).toEqual([])
  })

  it('keeps the listed order, drops repeats and entries this build cannot read', () => {
    const hosts = projectHostsInOrder(['runtime:env-1', 'local', 'runtime:env-1', 'cloud:x'])
    expect(hosts.map((host) => host.id)).toEqual(['runtime:env-1', 'local'])
  })
})

describe('pickProjectHost', () => {
  it('takes the first usable computer and names the ones passed over', () => {
    const pick = pickProjectHost(
      ['ssh:box', 'runtime:env-1', 'local'],
      (host) => host.kind !== 'ssh'
    )
    expect(pick.host?.id).toBe('runtime:env-1')
    expect(pick.passedOver.map((host) => host.id)).toEqual(['ssh:box'])
  })

  it('picks nothing when no listed computer is usable', () => {
    const pick = pickProjectHost(['ssh:box'], () => false)
    expect(pick).toEqual({ host: null, passedOver: [expect.objectContaining({ id: 'ssh:box' })] })
  })
})
