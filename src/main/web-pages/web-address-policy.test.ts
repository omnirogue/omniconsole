import type { LookupAddress } from 'node:dns'
import { describe, expect, it } from 'vitest'
import {
  blockedWebIp,
  pinnedWebLookup,
  WEB_ADDRESS_BLOCKED,
  type WebAddressAnswer,
  type WebResolver
} from './web-address-policy'

type LookupResult = { error: NodeJS.ErrnoException | null; address: unknown; family?: number }

function lookupOnce(resolve: WebResolver, options: { all?: boolean; family?: number } = {}) {
  const lookup = pinnedWebLookup(resolve)
  return new Promise<LookupResult>((done) => {
    lookup('pages.example', options, (error, address, family) => done({ error, address, family }))
  })
}

const answers =
  (...list: WebAddressAnswer[]): WebResolver =>
  async () =>
    list

const v4 = (address: string): WebAddressAnswer => ({ address, family: 4 })
const v6 = (address: string): WebAddressAnswer => ({ address, family: 6 })

describe('blockedWebIp', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.251',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255'
  ])('blocks the IPv4 address %s', (address) => {
    expect(blockedWebIp(address)).toBe(true)
  })

  it.each([
    '::',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::7f00:1',
    '::ffff:0:7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '100::1',
    '2001::1',
    '2001:db8::1',
    '2002:7f00:1::',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    'fe80::1%lo0',
    'fec0::1',
    'ff02::1'
  ])('blocks the IPv6 address %s', (address) => {
    expect(blockedWebIp(address)).toBe(true)
  })

  it.each(['', 'pages.example', '127.1', '1.2.3', 'not an address'])(
    'blocks %j, which is not a plain IP',
    (address) => {
      expect(blockedWebIp(address)).toBe(true)
    }
  )

  it.each(['93.184.215.14', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows the public address %s',
    (address) => {
      expect(blockedWebIp(address)).toBe(false)
    }
  )
})

describe('pinnedWebLookup', () => {
  it('refuses a host when any answer is blocked, even alongside a public one', async () => {
    const result = await lookupOnce(answers(v4('93.184.215.14'), v4('10.0.0.5')), { all: true })
    expect(result.error?.code).toBe(WEB_ADDRESS_BLOCKED)
  })

  it('refuses an IPv4-mapped loopback answer', async () => {
    const result = await lookupOnce(answers(v6('::ffff:127.0.0.1')), { all: true })
    expect(result.error?.code).toBe(WEB_ADDRESS_BLOCKED)
  })

  it('returns every validated answer for the all:true (autoSelectFamily) shape', async () => {
    const result = await lookupOnce(answers(v6('2606:4700:4700::1111'), v4('93.184.215.14')), {
      all: true
    })
    expect(result.error).toBeNull()
    expect(result.address as LookupAddress[]).toEqual([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '93.184.215.14', family: 4 }
    ])
  })

  it('returns one validated answer for the all:false shape, honouring the family', async () => {
    const both = answers(v6('2606:4700:4700::1111'), v4('93.184.215.14'))
    expect(await lookupOnce(both)).toEqual({
      error: null,
      address: '2606:4700:4700::1111',
      family: 6
    })
    expect(await lookupOnce(both, { family: 4 })).toEqual({
      error: null,
      address: '93.184.215.14',
      family: 4
    })
  })

  it('fails as not found when there is no answer of the requested family', async () => {
    expect((await lookupOnce(answers())).error?.code).toBe('ENOTFOUND')
    expect((await lookupOnce(answers(v4('93.184.215.14')), { family: 6 })).error?.code).toBe(
      'ENOTFOUND'
    )
  })

  it('passes a resolver failure through, including a synchronous throw', async () => {
    const failing: WebResolver = async () => {
      throw Object.assign(new Error('no such host'), { code: 'ENOTFOUND' })
    }
    expect((await lookupOnce(failing)).error?.code).toBe('ENOTFOUND')
    const throwing: WebResolver = () => {
      throw Object.assign(new Error('bad name'), { code: 'EBADNAME' })
    }
    expect((await lookupOnce(throwing)).error?.code).toBe('EBADNAME')
  })

  it('checks every resolution, so a rebind to 127.0.0.1 on the second lookup is refused', async () => {
    let calls = 0
    const rebinding: WebResolver = async () => {
      calls += 1
      return calls === 1 ? [v4('93.184.215.14')] : [v4('127.0.0.1')]
    }
    const lookup = pinnedWebLookup(rebinding)
    const run = () =>
      new Promise<LookupResult>((done) => {
        lookup('pages.example', { all: true }, (error, address) => done({ error, address }))
      })
    const first = await run()
    expect(first.address).toEqual([{ address: '93.184.215.14', family: 4 }])
    const second = await run()
    expect(second.error?.code).toBe(WEB_ADDRESS_BLOCKED)
    expect(calls).toBe(2)
  })
})
