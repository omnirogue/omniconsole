import { describe, expect, it } from 'vitest'
import { routes } from './console-workflow-routes'
import { waitFactsPath } from './console-waits-client'

const allowed = (method: 'GET' | 'POST', path: string) =>
  routes[method].some((route) => route.test.test(path))

describe('omnios wait facts routes', () => {
  it('allows exactly the facts query the client builds', () => {
    const path = waitFactsPath({
      source: 'slack',
      personId: 'emp_uma',
      ref: 'slack:D0123ABC:1727190000.123456',
      since: '2026-09-24T16:00:00.000Z',
      match: 'approve'
    })
    expect(allowed('GET', path)).toBe(true)
    expect(
      allowed(
        'GET',
        waitFactsPath({
          source: 'jira',
          personId: 'emp_iris',
          ref: 'OMR-12',
          since: '2026-09-24T16:00:00.000Z',
          match: 'reply'
        })
      )
    ).toBe(true)
    expect(allowed('GET', '/api/waits/people')).toBe(true)
    expect(allowed('POST', '/api/waits/ask')).toBe(true)
  })

  it('refuses a raw id, another source or extra parameters', () => {
    expect(allowed('GET', path('source=slack&person_id=U0123&ref=x&since=t&match=approve'))).toBe(
      false
    )
    expect(allowed('GET', path('source=github&person_id=emp_a&ref=x&since=t&match=approve'))).toBe(
      false
    )
    expect(
      allowed('GET', path('source=slack&person_id=emp_a&ref=x&since=t&match=approve&x=1'))
    ).toBe(false)
  })
})

function path(query: string): string {
  return `/api/waits/facts?${query}`
}
