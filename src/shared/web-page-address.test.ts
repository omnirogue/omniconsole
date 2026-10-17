import { describe, expect, it } from 'vitest'
import { checkWebPageAddress } from './web-page-address'

const codeOf = (raw: string, ports?: readonly number[]) => {
  const check = checkWebPageAddress(raw, ports)
  return check.ok ? 'ok' : check.reason.code
}

describe('checkWebPageAddress', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://files.example/readme.txt',
    'data:text/html,<p>hi</p>',
    'javascript:alert(1)',
    'ws://pages.example/',
    'not a url',
    ''
  ])('refuses %j by scheme', (raw) => {
    expect(codeOf(raw)).toBe('scheme')
  })

  it.each([
    'https://user@pages.example/',
    'https://user:secret@pages.example/',
    'https://:secret@pages.example/'
  ])('refuses the credentials in %s', (raw) => {
    expect(codeOf(raw)).toBe('credentials')
  })

  it.each([
    'http://pages.example:8080/',
    'https://pages.example:8443/',
    'http://pages.example:22/'
  ])('refuses the port in %s', (raw) => {
    expect(codeOf(raw)).toBe('port')
  })

  it('accepts ports 80 and 443 on either scheme, and a port a test explicitly allows', () => {
    expect(codeOf('http://pages.example/')).toBe('ok')
    expect(codeOf('https://pages.example:443/')).toBe('ok')
    expect(codeOf('http://pages.example:443/')).toBe('ok')
    expect(codeOf('http://pages.example:8080/', [80, 443, 8080])).toBe('ok')
  })

  it.each([
    'http://localhost/',
    'http://localhost./',
    'http://LOCALHOST/',
    'http://api.localhost/',
    'http://api.localhost./',
    'http://%6c%6fcalhost/',
    'http://\uff4c\uff4f\uff43\uff41\uff4c\uff48\uff4f\uff53\uff54/'
  ])('refuses the localhost name %s as a private address', (raw) => {
    expect(codeOf(raw)).toBe('private-address')
  })

  it.each([
    ['http://127.1/', '127.0.0.1'],
    ['http://2130706433/', '127.0.0.1'],
    ['http://0x7f000001/', '127.0.0.1'],
    ['http://0177.0.0.1/', '127.0.0.1'],
    ['http://127.0.0.1./', '127.0.0.1'],
    ['http://[::1]/', '::1'],
    ['http://[::ffff:127.0.0.1]/', '::ffff:7f00:1'],
    ['http://[::ffff:7f00:1]/', '::ffff:7f00:1'],
    ['http://0.0.0.0/', '0.0.0.0'],
    ['http://[::]/', '::'],
    ['http://169.254.169.254/latest/meta-data/', '169.254.169.254'],
    ['http://[fd00::1]/', 'fd00::1'],
    ['http://100.64.0.1/', '100.64.0.1'],
    ['http://[64:ff9b::a9fe:a9fe]/', '64:ff9b::a9fe:a9fe']
  ])('marks %s as the IP literal %s, to be checked before any connection', (raw, ip) => {
    const check = checkWebPageAddress(raw)
    expect(check.ok && check.address.ip).toBe(ip)
  })

  it('leaves a host name for the resolver and drops the fragment', () => {
    expect(checkWebPageAddress('HTTPS://Pages.Example/a/b?q=1#section')).toEqual({
      ok: true,
      address: {
        href: 'https://pages.example/a/b?q=1',
        secure: true,
        host: 'pages.example',
        port: 443,
        ip: null
      }
    })
  })
})
