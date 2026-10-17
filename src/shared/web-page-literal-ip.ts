// Main's BlockList ranges (web-address-policy.ts), so setup refuses a literal early; main still decides.
const IPV4_BLOCKED: readonly [string, number][] = [
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

const ipv4Number = (ip: string) =>
  ip.split('.').reduce((value, part) => value * 256 + Number(part), 0)

function ipv4Blocked(ip: string): boolean {
  const value = ipv4Number(ip)
  return IPV4_BLOCKED.some(([base, bits]) => {
    const size = 2 ** (32 - bits)
    return Math.floor(value / size) === Math.floor(ipv4Number(base) / size)
  })
}

// WHATWG URL writes IPv6 compressed and in hex (an embedded IPv4 too), so `::` is the only gap.
function hextets(ip: string): number[] | undefined {
  const [head, tail] = ip.split('::')
  const part = (text: string | undefined) => (text ? text.split(':') : [])
  const left = part(head)
  const right = part(tail)
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  const values = groups.map((group) => Number.parseInt(group, 16))
  return values.length === 8 && values.every((value) => value >= 0 && value <= 0xffff)
    ? values
    : undefined
}

function ipv6Blocked(ip: string): boolean {
  const h = hextets(ip)
  if (!h) {
    return true
  }
  const [a, b, c, d] = h as [number, number, number, number]
  return (
    // ::, ::1, IPv4-mapped and IPv4-compatible addresses all start with 80 zero bits.
    h.slice(0, 5).every((value) => value === 0) ||
    // 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64) both start 64:ff9b.
    (a === 0x64 && b === 0xff9b) ||
    (a === 0x100 && b === 0 && c === 0 && d === 0) ||
    (a === 0x2001 && (b === 0 || b === 0xdb8)) ||
    a === 0x2002 ||
    (a & 0xfe00) === 0xfc00 ||
    (a & 0xffc0) === 0xfe80 ||
    (a & 0xffc0) === 0xfec0 ||
    (a & 0xff00) === 0xff00
  )
}

/** Whether an IP literal (as checkWebPageAddress gives it) points at a private or special range. */
export function webPageLiteralIpIsPrivate(ip: string): boolean {
  return ip.includes(':') ? ipv6Blocked(ip) : ipv4Blocked(ip)
}
