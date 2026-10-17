# Fixture spec

Three independent functions. Each task names exactly one of them. Plain Node ESM, no dependencies;
`node --test test/<name>.check.mjs` runs that function's public tests.

## slugify(title, options) — `src/slug.mjs`

Returns a URL slug for `title`.

1. Normalize with Unicode NFKD and drop combining marks, so `é` becomes `e`.
2. Lowercase.
3. Every run of characters outside `a-z` and `0-9` becomes one hyphen.
4. Remove leading and trailing hyphens.
5. `options.maxLength` (a positive integer, default 60) caps the length. Cut at the cap, then remove
   any trailing hyphen the cut left behind. Never cut to an empty string: see rule 6.
6. If the result is empty (the title had no usable characters), return `untitled`.
7. A non-string `title` throws `TypeError`.

## authorizeWorkerStart(request, policy) — `src/host-guard.mjs`

Decides whether a worker may start on a host. Returns `{ allowed: boolean, reason: string }` and
never throws: any malformed input is `{ allowed: false, reason: 'malformed-request' }`.

`request` is `{ host: string, account: string, scopes: string[], action?: { id: string, needsApproval: boolean }, approval?: { instanceId: string, by: string } }`.

`policy` is `{ hosts: Record<string, { reachability: 'live' | 'unverifiable' | 'exited', accounts: Record<string, { verified: boolean, scopes: string[] }> }> }`.

Checks, in this order; the first that fails decides the reason:

1. `malformed-request`: `request` or `policy` is not an object, `host` or `account` is not a
   non-empty string, or `scopes` is not an array of strings.
2. `unknown-host`: `policy.hosts` has no OWN entry for `request.host`. Inherited keys such as
   `__proto__`, `constructor` or `toString` are never hosts. Host names are case-sensitive.
3. `host-unverifiable`: the host's reachability is `unverifiable`. Loss of contact is not `exited`
   and is never treated as allowed.
4. `host-exited`: the host's reachability is `exited`.
5. `unknown-account`: the host has no OWN account entry for `request.account`.
6. `account-unverified`: the account's `verified` is not exactly `true`. Never fall back to another
   account.
7. `scope-not-granted`: any requested scope is missing from the account's `scopes`. An empty
   `request.scopes` requests nothing and passes this check.
8. `approval-required`: `request.action.needsApproval` is `true` and there is no `request.approval`
   whose `instanceId` equals `request.action.id` exactly and whose `by` is a non-empty string. An
   approval for a different instance does not count.

When every check passes: `{ allowed: true, reason: 'ok' }`.

## rollupUsage(attempts) — `src/usage-rollup.mjs`

Summarizes the attempts of one piece of work. `attempts` is an array of
`{ outcome: 'succeeded' | 'failed', startedAtMs: number, endedAtMs: number, retryOf?: string, inputTokens?: number, outputTokens?: number, costUsd?: number }`.

Returns:

```js
{
  attempts,        // how many attempts
  succeeded,       // how many with outcome 'succeeded'
  failed,          // how many with outcome 'failed'
  retries,         // how many attempts have a retryOf
  wallClockMs,     // latest endedAtMs minus earliest startedAtMs; 0 for no attempts
  activeMs,        // sum of (endedAtMs - startedAtMs) over attempts
  tokens,          // { input, output } when EVERY attempt reported both token counts, else 'unknown'
  partialTokens,   // { input, output, reportedAttempts }: the sum over attempts that reported both
  costUsd          // the sum when EVERY attempt reported costUsd, else 'unknown'
}
```

Rules:

- What was not reported is `'unknown'`, never 0. One attempt without token counts makes `tokens`
  `'unknown'`; the known part still appears under `partialTokens`.
- An attempt reports tokens only when BOTH `inputTokens` and `outputTokens` are finite numbers
  greater than or equal to 0. A reported 0 is a real 0.
- For no attempts every count is 0, `tokens` is `{ input: 0, output: 0 }`, `partialTokens` is
  `{ input: 0, output: 0, reportedAttempts: 0 }` and `costUsd` is 0.
- `costUsd` sums are rounded to 6 decimal places.
- A non-array argument throws `TypeError`.
