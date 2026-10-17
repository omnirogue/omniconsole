import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { WEB_PAGE_PORTS } from '../../shared/web-page-address'

const IPV4_BLOCKED: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]

// ::/96 and ::ffff:0:0:0/96 embed IPv4 in forms BlockList does not map back to its IPv4 rules.
const IPV6_BLOCKED: readonly (readonly [string, number])[] = [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8]
]

const BLOCKED = new BlockList()
for (const [network, prefix] of IPV4_BLOCKED) {
  BLOCKED.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of IPV6_BLOCKED) {
  BLOCKED.addSubnet(network, prefix, 'ipv6')
}

/** True when an address must never be connected to. Anything that is not a plain IP is blocked. */
export function blockedWebIp(address: string): boolean {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  // A zone id makes BlockList miss the link-local rule, and no public address carries one.
  if (bare.includes('%')) {
    return true
  }
  const family = isIP(bare)
  if (family === 0) {
    return true
  }
  try {
    return BLOCKED.check(bare, family === 4 ? 'ipv4' : 'ipv6')
  } catch {
    return true
  }
}

/** The addresses and ports a page may be read from. Tests inject their own; the app never does. */
export type WebAddressPolicy = {
  ports: readonly number[]
  blocked: (address: string) => boolean
}

export const WEB_ADDRESS_POLICY: WebAddressPolicy = Object.freeze({
  ports: WEB_PAGE_PORTS,
  blocked: blockedWebIp
})

export type WebAddressAnswer = { address: string; family: number }

/** Every address a host name resolves to, in both families. */
export type WebResolver = (host: string) => Promise<readonly WebAddressAnswer[]>

export const resolveWebHost: WebResolver = (host) => dnsLookup(host, { all: true })

/** The error code a pinned lookup fails with when a host resolves to a blocked address. */
export const WEB_ADDRESS_BLOCKED = 'ERR_OMNI_WEB_ADDRESS_BLOCKED'

function lookupError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

function requestedFamily(family: number | 'IPv4' | 'IPv6' | undefined): number {
  if (family === 'IPv4') {
    return 4
  }
  if (family === 'IPv6') {
    return 6
  }
  return family ?? 0
}

/**
 * A `lookup` for net/tls sockets that resolves once, refuses the host when ANY answer is blocked,
 * and hands the socket only the addresses it validated, so nothing can rebind between check and connect.
 */
export function pinnedWebLookup(
  resolve: WebResolver = resolveWebHost,
  blocked: (address: string) => boolean = blockedWebIp
): LookupFunction {
  return (hostname, options, callback) => {
    Promise.resolve(hostname)
      .then(resolve)
      .then(
        (answers) => {
          if (answers.some((answer) => blocked(answer.address))) {
            callback(
              lookupError(`${hostname} resolves to a blocked address`, WEB_ADDRESS_BLOCKED),
              ''
            )
            return
          }
          const family = requestedFamily(options.family)
          const fitting = answers
            .filter((answer) => family === 0 || answer.family === family)
            .map(({ address, family: answerFamily }) => ({ address, family: answerFamily }))
          const first = fitting[0]
          if (!first) {
            callback(lookupError(`${hostname} has no address`, 'ENOTFOUND'), '')
            return
          }
          if (options.all) {
            callback(null, fitting)
            return
          }
          callback(null, first.address, first.family)
        },
        (error: NodeJS.ErrnoException) => callback(error, '')
      )
  }
}
