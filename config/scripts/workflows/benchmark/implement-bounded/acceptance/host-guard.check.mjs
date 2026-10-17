import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeWorkerStart } from '../src/host-guard.mjs'

const policy = {
  hosts: {
    studio: {
      reachability: 'live',
      accounts: {
        main: { verified: true, scopes: ['read', 'write'] },
        spare: { verified: false, scopes: ['read', 'write'] },
        truthy: { verified: 'yes', scopes: ['read'] }
      }
    },
    rented: {
      reachability: 'unverifiable',
      accounts: { main: { verified: true, scopes: ['read'] } }
    },
    retired: { reachability: 'exited', accounts: { main: { verified: true, scopes: ['read'] } } }
  }
}

const reason = (request, usePolicy = policy) => authorizeWorkerStart(request, usePolicy).reason

test('never throws on malformed input', () => {
  for (const request of [
    null,
    undefined,
    'studio',
    7,
    {},
    { host: '', account: 'main', scopes: [] }
  ]) {
    assert.deepEqual(authorizeWorkerStart(request, policy), {
      allowed: false,
      reason: 'malformed-request'
    })
  }
  assert.equal(reason({ host: 'studio', account: 'main', scopes: 'read' }), 'malformed-request')
  assert.equal(reason({ host: 'studio', account: 'main', scopes: [1] }), 'malformed-request')
  assert.equal(reason({ host: 'studio', account: 'main', scopes: [] }, null), 'malformed-request')
})

test('inherited keys are never hosts or accounts', () => {
  for (const host of ['__proto__', 'constructor', 'toString']) {
    assert.equal(reason({ host, account: 'main', scopes: [] }), 'unknown-host')
  }
  assert.equal(reason({ host: 'studio', account: 'constructor', scopes: [] }), 'unknown-account')
  assert.equal(reason({ host: 'Studio', account: 'main', scopes: [] }), 'unknown-host')
})

test('unverifiable is not exited and neither is allowed', () => {
  assert.equal(reason({ host: 'rented', account: 'main', scopes: [] }), 'host-unverifiable')
  assert.equal(reason({ host: 'retired', account: 'main', scopes: [] }), 'host-exited')
})

test('an unverified account is refused with no fallback', () => {
  assert.equal(reason({ host: 'studio', account: 'spare', scopes: ['read'] }), 'account-unverified')
  assert.equal(
    reason({ host: 'studio', account: 'truthy', scopes: ['read'] }),
    'account-unverified'
  )
  assert.equal(reason({ host: 'studio', account: 'ghost', scopes: ['read'] }), 'unknown-account')
})

test('checks run in the stated order', () => {
  assert.equal(
    reason({ host: 'rented', account: 'ghost', scopes: ['deploy'] }),
    'host-unverifiable'
  )
  assert.equal(
    reason({ host: 'studio', account: 'spare', scopes: ['deploy'] }),
    'account-unverified'
  )
})

test('an approval must name this exact instance', () => {
  const request = {
    host: 'studio',
    account: 'main',
    scopes: ['write'],
    action: { id: 'release-42', needsApproval: true }
  }
  assert.equal(reason(request), 'approval-required')
  assert.equal(
    reason({ ...request, approval: { instanceId: 'release-41', by: 'sal' } }),
    'approval-required'
  )
  assert.equal(
    reason({ ...request, approval: { instanceId: 'release-42', by: '' } }),
    'approval-required'
  )
  assert.deepEqual(
    authorizeWorkerStart({ ...request, approval: { instanceId: 'release-42', by: 'sal' } }, policy),
    { allowed: true, reason: 'ok' }
  )
  assert.deepEqual(
    authorizeWorkerStart({ ...request, action: { id: 'read-1', needsApproval: false } }, policy),
    { allowed: true, reason: 'ok' }
  )
})

test('empty scopes request nothing', () => {
  assert.deepEqual(authorizeWorkerStart({ host: 'studio', account: 'main', scopes: [] }, policy), {
    allowed: true,
    reason: 'ok'
  })
})
