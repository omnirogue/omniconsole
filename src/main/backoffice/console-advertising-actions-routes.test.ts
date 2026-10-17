import { describe, expect, it } from 'vitest'
import { routes } from './console-workflow-routes'

const base = '/api/gtd/hub/api/actions'
const id = `act_${'a'.repeat(32)}`
const allowed = (method: keyof typeof routes, path: string) =>
  routes[method].some((route) => route.test.test(path))

describe('advertising action route boundary', () => {
  it('admits exactly the supported discovery, preview, receipt, execution and verification shapes', () => {
    for (const company of ['omnirogue', 'betacorp']) {
      expect(allowed('GET', `${base}/capabilities?domain=advertising&company=${company}`)).toBe(
        true
      )
    }
    expect(allowed('GET', `${base}/${id}`)).toBe(true)
    expect(allowed('POST', `${base}/preview`)).toBe(true)
    expect(allowed('POST', `${base}/${id}/execute`)).toBe(true)
    expect(allowed('POST', `${base}/${id}/verify`)).toBe(true)
  })

  it.each([
    base,
    `${base}/capabilities`,
    `${base}/capabilities?domain=finance&company=omnirogue`,
    `${base}/capabilities?domain=advertising&company=acme`,
    `${base}/capabilities?domain=advertising&company=omnirogue&actor=other`,
    `${base}/capabilities?company=omnirogue&domain=advertising`,
    `${base}/act_short`,
    `${base}/${id}?company=betacorp`,
    `${base}/${id}/undo`,
    `${base}/${id}/execute/extra`,
    `${base}/${id}/verify?approved=true`,
    `${base}/../${id}`,
    `${base}/%2e%2e/${id}`
  ])('refuses extra methods, traversal, scope and action routes: %s', (path) => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
      expect(allowed(method, path)).toBe(false)
    }
  })

  it('does not permit alternate verbs on the supported paths', () => {
    expect(allowed('POST', `${base}/${id}`)).toBe(false)
    expect(allowed('GET', `${base}/preview`)).toBe(false)
    expect(allowed('GET', `${base}/${id}/execute`)).toBe(false)
    expect(allowed('PATCH', `${base}/${id}/execute`)).toBe(false)
    expect(allowed('DELETE', `${base}/${id}`)).toBe(false)
  })
})
