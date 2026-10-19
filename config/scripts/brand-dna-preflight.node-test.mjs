import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { main } from './brand-dna-preflight.mjs'

const origin = 'https://pr-123.preview.omnirogue.com'
const args = ['--origin', origin, '--expect', 'available']
const env = { BRAND_DNA_QA_TOKEN: 'tester-one', BRAND_DNA_QA_OTHER_TOKEN: 'tester-two' }
const first = { id: '00000000-0000-4000-8000-000000000001', name: 'Private brand A' }
const second = { id: '00000000-0000-4000-8000-000000000002', name: 'Private brand B' }
const detail = (brand) => ({ brand, assets: [], campaigns: [] })
const denied = { error: { code: 'NOT_FOUND', message: 'private error detail' } }
const success = [
  [401, {}],
  [200, { brands: [first] }],
  [200, { brands: [second] }],
  [200, detail(first)],
  [404, denied],
  [200, detail(second)],
  [404, denied]
]

function fixture(responses = success) {
  const calls = []
  const fetcher = async (...call) => {
    calls.push(call)
    const response = responses[calls.length - 1]
    assert.ok(response, 'unexpected request')
    if (response instanceof Error) {
      throw response
    }
    const [status, body] = response
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }
  return { calls, fetcher }
}

test('reads existing brands and verifies ownership in both directions, without writes or disclosure', async () => {
  const { calls, fetcher } = fixture()
  const result = await main(args, env, fetcher)
  assert.equal(result.exitCode, 0)
  const report = JSON.parse(result.output)
  assert.equal(report.passed, true)
  assert.equal(report.checks.length, 8)
  assert.match(report.scope, /rollout approval remain manual/)
  assert.equal(calls.length, 7)
  assert.equal(calls[0][1].headers.Authorization, undefined)
  assert.equal(calls[1][1].headers.Authorization, 'Bearer tester-one')
  assert.equal(calls[2][1].headers.Authorization, 'Bearer tester-two')
  assert.deepEqual(
    calls.slice(3).map(([url, options]) => [url, options.headers.Authorization]),
    [
      [`${origin}/api/dna/brands/${first.id}`, 'Bearer tester-one'],
      [`${origin}/api/dna/brands/${first.id}`, 'Bearer tester-two'],
      [`${origin}/api/dna/brands/${second.id}`, 'Bearer tester-two'],
      [`${origin}/api/dna/brands/${second.id}`, 'Bearer tester-one']
    ]
  )
  for (const [, options] of calls) {
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.body, undefined)
  }
  for (const secret of [
    ...Object.values(env),
    first.id,
    first.name,
    second.id,
    'private error detail'
  ]) {
    assert.ok(!result.output.includes(secret))
  }
})

test('gated mode requires the specific Brand DNA refusal and needs only one tester', async () => {
  const { fetcher, calls } = fixture([
    [401, {}],
    [403, { error: { code: 'BRAND_DNA_NOT_AVAILABLE' } }]
  ])
  const result = await main(
    ['--origin', origin, '--expect', 'gated'],
    { BRAND_DNA_QA_TOKEN: 'tester' },
    fetcher
  )
  assert.equal(result.exitCode, 0)
  assert.equal(calls.length, 2)
})

test('does not mistake auth failures, outages or accessible brands for the rollout gate', async () => {
  for (const response of [
    [401, {}],
    [403, { error: { code: 'FORBIDDEN' } }],
    [503, {}],
    [200, { brands: [] }]
  ]) {
    const { fetcher } = fixture([[401, {}], response])
    assert.equal((await main(['--origin', origin, '--expect', 'gated'], env, fetcher)).exitCode, 1)
  }
})

test('fails closed on anonymous access or invalid JSON before sending a token', async () => {
  for (const response of [
    [200, { brands: [first] }],
    [403, {}],
    [401, '<html>Login</html>'],
    new Error('token in network exception')
  ]) {
    const { calls, fetcher } = fixture([response])
    const result = await main(args, env, fetcher)
    assert.equal(result.exitCode, 1)
    assert.equal(calls.length, 1)
    assert.ok(!result.output.includes('token in network exception'))
  }
})

test('rejects empty, malformed, duplicate or overlapping brand fixtures', async () => {
  for (const body of [
    {},
    { brands: [] },
    { brands: [{ id: '../escape', name: 'x' }] },
    { brands: [null] },
    { brands: [{ ...first, name: '' }] },
    { brands: [first, first] }
  ]) {
    const { fetcher } = fixture([
      [401, {}],
      [200, body]
    ])
    assert.equal((await main(args, env, fetcher)).exitCode, 1)
  }
  const { fetcher, calls } = fixture([
    [401, {}],
    [200, { brands: [first] }],
    [200, { brands: [first] }]
  ])
  assert.equal((await main(args, env, fetcher)).exitCode, 1)
  assert.equal(calls.length, 3)
})

test('cannot pass if either account can read the other account brand or a detail is inconsistent', async () => {
  for (const [index, replacement] of [
    [3, [200, detail(second)]],
    [3, [200, { brand: first }]],
    [4, [200, detail(first)]],
    [4, [404, {}]],
    [5, [503, {}]],
    [6, [200, detail(second)]]
  ]) {
    const responses = success.map((response, i) => (i === index ? replacement : response))
    assert.equal((await main(args, env, fixture(responses).fetcher)).exitCode, 1)
  }
})

test('redirects and timeouts are failures, with no retry or exception disclosure', async () => {
  for (const failure of [
    new TypeError('redirect to secret.example'),
    new DOMException('private token', 'TimeoutError')
  ]) {
    const { fetcher, calls } = fixture([[401, {}], failure])
    const result = await main(args, env, fetcher)
    assert.equal(result.exitCode, 1)
    assert.equal(calls.length, 2)
    assert.ok(!result.output.includes(failure.message))
  }
})

test('validates origin, expected mode and environment before any request', async () => {
  const { fetcher, calls } = fixture([])
  for (const url of [
    'http://example.com',
    'https://user:secret@example.com',
    `${origin}/path`,
    `${origin}?token=secret`,
    `${origin}#x`,
    'invalid'
  ]) {
    const result = await main(['--origin', url, '--expect', 'available'], env, fetcher)
    assert.equal(result.exitCode, 2)
    assert.ok(!result.output.includes('secret'))
  }
  for (const invalidArgs of [
    [],
    ['--token', 'secret'],
    [...args, '--expect', 'gated'],
    ['--origin', origin, '--expect', 'typo']
  ]) {
    assert.equal((await main(invalidArgs, env, fetcher)).exitCode, 2)
  }
  for (const invalidEnv of [
    {},
    { BRAND_DNA_QA_TOKEN: 'x' },
    { BRAND_DNA_QA_TOKEN: 'x', BRAND_DNA_QA_OTHER_TOKEN: 'x' },
    { ...env, BRAND_DNA_QA_TOKEN: 'bad\r\nheader' }
  ]) {
    assert.equal((await main(args, invalidEnv, fetcher)).exitCode, 2)
  }
  assert.equal((await main(['--help'], {}, fetcher)).exitCode, 0)
  assert.equal(calls.length, 0)
})

test('executes the checks over HTTP and refuses a real redirect before forwarding credentials', async () => {
  const requests = []
  let redirect = false
  const server = createServer((request, response) => {
    requests.push(request.url)
    response.setHeader('Content-Type', 'application/json')
    if (redirect && request.headers.authorization) {
      response.writeHead(302, { Location: '/must-not-follow' })
      response.end('{}')
      return
    }
    const owner = request.headers.authorization === 'Bearer tester-one' ? first : second
    const body = !request.headers.authorization
      ? [401, {}]
      : request.url === '/api/dna/brands'
        ? [200, { brands: [owner] }]
        : request.url === `/api/dna/brands/${owner.id}`
          ? [200, detail(owner)]
          : [404, denied]
    response.writeHead(body[0])
    response.end(JSON.stringify(body[1]))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const localOrigin = `http://127.0.0.1:${server.address().port}`
    const fetcher = (url, options) => fetch(url.replace(origin, localOrigin), options)
    assert.equal((await main(args, env, fetcher)).exitCode, 0)
    assert.equal(requests.length, 7)
    redirect = true
    requests.length = 0
    assert.equal((await main(args, env, fetcher)).exitCode, 1)
    assert.deepEqual(requests, ['/api/dna/brands', '/api/dna/brands'])
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
