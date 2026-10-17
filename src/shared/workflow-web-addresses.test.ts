import { describe, expect, it } from 'vitest'
import { workflowWebAddresses } from './workflow-web-addresses'

describe('the addresses a request names', () => {
  it('finds each http(s) address, normalised, without the punctuation around it', () => {
    expect(
      workflowWebAddresses(
        'Compare https://Example.com/pricing#plans, and (see http://docs.example.org/guide). Also [ours](https://ours.example/a_(b)).'
      )
    ).toEqual([
      'https://example.com/pricing',
      'http://docs.example.org/guide',
      'https://ours.example/a_(b)'
    ])
  })

  it('lists a page once, even when it is written differently', () => {
    expect(
      workflowWebAddresses(
        'https://example.com/a and https://EXAMPLE.com/a#top and https://example.com/a.'
      )
    ).toEqual(['https://example.com/a'])
  })

  it('leaves out what the shared policy refuses, private addresses included', () => {
    expect(
      workflowWebAddresses(
        [
          'ftp://example.com/file',
          'https://user:pw@example.com/',
          'https://example.com:8443/',
          'http://localhost/admin',
          'http://127.0.0.1/',
          'http://169.254.169.254/latest/meta-data',
          'http://[::1]/',
          'http://10.0.0.8/',
          'https://ok.example/'
        ].join(' ')
      )
    ).toEqual(['https://ok.example/'])
  })

  it('reads the evidence after the request, and stops at a step’s page limit', () => {
    expect(
      workflowWebAddresses('https://a.example/', 'https://b.example/ https://a.example/')
    ).toEqual(['https://a.example/', 'https://b.example/'])
    const many = Array.from({ length: 20 }, (_, index) => `https://site.example/${index}`).join(' ')
    expect(workflowWebAddresses(many)).toHaveLength(12)
    expect(workflowWebAddresses(undefined, '')).toEqual([])
  })
})
