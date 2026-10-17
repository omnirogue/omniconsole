import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeWorkerStart } from '../src/host-guard.mjs'

const policy = {
  hosts: {
    studio: {
      reachability: 'live',
      accounts: { main: { verified: true, scopes: ['read', 'write'] } }
    },
    rented: {
      reachability: 'unverifiable',
      accounts: { main: { verified: true, scopes: ['read'] } }
    }
  }
}

test('allows a verified account on a live host', () => {
  assert.deepEqual(
    authorizeWorkerStart({ host: 'studio', account: 'main', scopes: ['read'] }, policy),
    { allowed: true, reason: 'ok' }
  )
})

test('refuses an unknown host and an unverifiable one', () => {
  assert.equal(
    authorizeWorkerStart({ host: 'nowhere', account: 'main', scopes: [] }, policy).reason,
    'unknown-host'
  )
  assert.equal(
    authorizeWorkerStart({ host: 'rented', account: 'main', scopes: ['read'] }, policy).reason,
    'host-unverifiable'
  )
})

test('refuses a scope the account was not granted', () => {
  assert.deepEqual(
    authorizeWorkerStart({ host: 'studio', account: 'main', scopes: ['deploy'] }, policy),
    { allowed: false, reason: 'scope-not-granted' }
  )
})
