#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCOPE =
  'Read-only API access and ownership checks; upload, rendering and rollout approval remain manual.'
const HELP = `Brand DNA preflight (W11-19 Phase 0; GET requests only)
Usage: brand-dna-preflight --origin https://pr-N.preview.omnirogue.com --expect gated|available

Set BRAND_DNA_QA_TOKEN to a tester's session token in the execution host's environment.
For available mode, also set BRAND_DNA_QA_OTHER_TOKEN for a different tester.
Both testers need an existing saved brand. No brands or flags are created or changed.
Never pass tokens as arguments. Output contains check names/statuses, not account data.
Exit codes: 0 checks passed, 1 checks failed/incomplete, 2 invalid configuration.
${SCOPE}`

function configuration(args, env) {
  if (args.length === 1 && args[0] === '--help') {
    return null
  }
  const values = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    if (!['--origin', '--expect'].includes(key) || !args[i + 1] || values[key]) {
      throw new Error(
        'Use --help for the supported arguments; tokens belong in environment variables.'
      )
    }
    values[key] = args[i + 1]
  }
  let origin
  try {
    origin = new URL(values['--origin'])
  } catch {
    throw new Error('Supply an HTTPS --origin without credentials, path, query or fragment.')
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('Supply an HTTPS --origin without credentials, path, query or fragment.')
  }
  const mode = values['--expect']
  if (!['gated', 'available'].includes(mode)) {
    throw new Error('--expect must be gated or available.')
  }
  const token = env.BRAND_DNA_QA_TOKEN?.trim()
  const otherToken = env.BRAND_DNA_QA_OTHER_TOKEN?.trim()
  if (!token || /\s/.test(token)) {
    throw new Error('Set BRAND_DNA_QA_TOKEN in the execution host environment.')
  }
  if (mode === 'available' && (!otherToken || /\s/.test(otherToken) || token === otherToken)) {
    throw new Error('Available mode needs a distinct BRAND_DNA_QA_OTHER_TOKEN.')
  }
  return { origin: origin.origin, mode, token, otherToken }
}

function savedBrands(response) {
  const brands = response.body?.brands
  if (response.status !== 200 || !Array.isArray(brands) || !brands.length) {
    return null
  }
  if (
    brands.some(
      (brand) => !UUID.test(brand?.id) || typeof brand.name !== 'string' || !brand.name.trim()
    )
  ) {
    return null
  }
  if (new Set(brands.map((brand) => brand.id.toLowerCase())).size !== brands.length) {
    return null
  }
  return brands
}

function isDetail(response, brand) {
  return (
    response.status === 200 &&
    response.body?.brand?.id === brand.id &&
    response.body.brand.name === brand.name &&
    Array.isArray(response.body.assets) &&
    Array.isArray(response.body.campaigns)
  )
}

export async function runPreflight(config, fetcher = fetch) {
  const checks = []
  function check(name, passed, status) {
    checks.push({ name, passed, ...(status === undefined ? {} : { httpStatus: status }) })
    return passed
  }
  async function get(path, token) {
    try {
      const response = await fetcher(`${config.origin}/api/dna${path}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      })
      // Never emit response bodies: they can contain private brands or proxy errors.
      const body = await response.json()
      return { status: response.status, body }
    } catch {
      return { status: null, body: null }
    }
  }
  function report() {
    return {
      origin: config.origin,
      expectation: config.mode,
      scope: SCOPE,
      passed: checks.every((item) => item.passed),
      checks
    }
  }

  const anonymous = await get('/brands')
  if (!check('anonymous access denied', anonymous.status === 401, anonymous.status)) {
    return report()
  }
  const own = await get('/brands', config.token)
  if (config.mode === 'gated') {
    check(
      'tester blocked by Brand DNA gate',
      own.status === 403 && own.body?.error?.code === 'BRAND_DNA_NOT_AVAILABLE',
      own.status
    )
    return report()
  }
  const brands = savedBrands(own)
  if (!check('tester has saved brands', Boolean(brands), own.status)) {
    return report()
  }
  const other = await get('/brands', config.otherToken)
  const otherBrands = savedBrands(other)
  if (!check('second tester has saved brands', Boolean(otherBrands), other.status)) {
    return report()
  }
  const ownIds = new Set(brands.map((brand) => brand.id.toLowerCase()))
  if (
    !check(
      'tester brand lists are disjoint',
      otherBrands.every((brand) => !ownIds.has(brand.id.toLowerCase()))
    )
  ) {
    return report()
  }
  for (const [name, brand, ownerToken, foreignToken] of [
    ['tester', brands[0], config.token, config.otherToken],
    ['second tester', otherBrands[0], config.otherToken, config.token]
  ]) {
    const detail = await get(`/brands/${brand.id}`, ownerToken)
    check(`${name} can read saved brand`, isDetail(detail, brand), detail.status)
    const foreign = await get(`/brands/${brand.id}`, foreignToken)
    check(
      `${name} brand hidden from other account`,
      foreign.status === 404 && foreign.body?.error?.code === 'NOT_FOUND',
      foreign.status
    )
  }
  return report()
}

export async function main(args = process.argv.slice(2), env = process.env, fetcher = fetch) {
  let config
  try {
    config = configuration(args, env)
  } catch (error) {
    return { exitCode: 2, output: JSON.stringify({ error: error.message }) }
  }
  if (!config) {
    return { exitCode: 0, output: HELP }
  }
  const report = await runPreflight(config, fetcher)
  return { exitCode: report.passed ? 0 : 1, output: JSON.stringify(report, null, 2) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main()
  console.log(result.output)
  process.exitCode = result.exitCode
}
