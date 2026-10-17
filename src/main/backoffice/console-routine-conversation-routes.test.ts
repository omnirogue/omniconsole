import { expect, it } from 'vitest'
import { routineConversationRoutes as routes } from './console-routine-conversation-routes'

it.each([
  ['GET', '/api/work/card/btk_demo/conversation'],
  ['POST', '/api/board/btk_demo/message']
] as const)('allows only the exact %s path %s', (method, path) => {
  expect(routes[method].some((route) => route.test.test(path))).toBe(true)
  for (const unsafe of [
    `${path}?x=1`,
    `${path}/extra`,
    path.replace('btk_demo', 'btk_ab_cd'),
    path.replace('btk_demo', 'btk_abc')
  ]) {
    expect(routes[method].some((route) => route.test.test(unsafe))).toBe(false)
  }
  expect(routes[method === 'GET' ? 'POST' : 'GET'].some((route) => route.test.test(path))).toBe(
    false
  )
})
