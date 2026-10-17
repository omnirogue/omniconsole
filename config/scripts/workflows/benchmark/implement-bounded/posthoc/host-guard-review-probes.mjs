// Post hoc probes for the host-guard task, written from the independent reviews of the first
// benchmark run (2026-10-03). They are NOT part of the frozen v1 acceptance key: v1 passed
// implementations these probes show to be unsafe. Use them to judge what a review bought, and as
// the starting point of a v2 key.
//
//   node posthoc/host-guard-review-probes.mjs /abs/path/to/src/host-guard.mjs
import { pathToFileURL } from 'node:url'

const { authorizeWorkerStart: check } = await import(pathToFileURL(process.argv[2]).href)

const policy = () => ({
  hosts: {
    studio: { reachability: 'live', accounts: { main: { verified: true, scopes: ['read'] } } }
  }
})
const request = { host: 'studio', account: 'main', scopes: ['read'] }
const mutate = (change) => {
  const next = policy()
  change(next)
  return next
}

/** Every probe must be refused; `reason` is what SPEC.md requires. */
const probes = [
  [
    'reachability missing',
    request,
    mutate((p) => delete p.hosts.studio.reachability),
    'malformed-request'
  ],
  [
    'reachability not a known state',
    request,
    mutate((p) => (p.hosts.studio.reachability = 'offline')),
    'malformed-request'
  ],
  [
    'scopes array with its own every()',
    { ...request, scopes: Object.assign(['deploy'], { every: () => true }) },
    policy(),
    'scope-not-granted'
  ],
  ['sparse scopes array', { ...request, scopes: Array(1) }, policy(), 'malformed-request'],
  [
    'needsApproval is the string "true"',
    { ...request, action: { id: 'deploy-1', needsApproval: 'true' } },
    policy(),
    'malformed-request'
  ],
  [
    'approval and action both lack an id',
    { ...request, action: { needsApproval: true }, approval: { by: 'Sal' } },
    policy(),
    'malformed-request'
  ],
  [
    'account has no scopes list',
    { ...request, scopes: [] },
    mutate((p) => delete p.hosts.studio.accounts.main.scopes),
    'malformed-request'
  ],
  ['policy has no hosts', request, {}, 'malformed-request']
]

const results = probes.map(([name, probeRequest, probePolicy, reason]) => {
  let outcome
  try {
    outcome = check(probeRequest, probePolicy)
  } catch (error) {
    outcome = { allowed: false, reason: `threw ${error?.constructor?.name ?? 'error'}` }
  }
  return {
    name,
    unsafeAllow: outcome?.allowed === true,
    exactReason: outcome?.allowed === false && outcome.reason === reason,
    got: outcome
  }
})
console.log(
  JSON.stringify(
    {
      probes: results.length,
      unsafeAllows: results.filter((result) => result.unsafeAllow).length,
      exactReason: results.filter((result) => result.exactReason).length,
      results
    },
    null,
    2
  )
)
