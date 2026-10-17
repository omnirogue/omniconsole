import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { authenticateSessionPrepConnector } from './session-prep-connector-authority'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => state.home
}))

const keys = generateKeyPairSync('ed25519')
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function write(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, text, { mode: 0o600 })
}

function fixture() {
  state.home = realpathSync(mkdtempSync(join(tmpdir(), 'prep-default-key-')))
  vi.stubEnv('OMNI_SESSION_PREP_VERIFY_KEY_FILE', undefined)
  const configDir = join(state.home, '.config', 'omni')
  const keyFile = join(configDir, 'session-prep-verify.pem')
  write(
    join(configDir, 'ai-operations-host.json'),
    JSON.stringify({
      execution_host: 'macserver',
      state_dir: state.home,
      workspace_roots: [state.home]
    })
  )
  const requestId = 'default-key-request'
  const nativeOperationId = `1760400000000-${'a'.repeat(32)}`
  const managedToolsFile = join(state.home, 'session-tools', requestId, 'descriptor.json')
  write(
    managedToolsFile,
    JSON.stringify({
      operation_id: requestId,
      native_operation_id: nativeOperationId,
      principal: { employee_id: 'emp_sal' }
    })
  )
  const text = 'Fix the login timeout.'
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      aud: 'session-prep',
      raw: false,
      purpose: 'launch',
      nonce: 'e2b79bdd-907a-4f4e-ae34-a5f75c0ad520',
      operator: 'emp_sal',
      requestId,
      text,
      workspace: state.home,
      title: 'Login fix',
      executionHost: 'macserver',
      issuedAt: now,
      expiresAt: now + 300
    })
  ).toString('base64url')
  const connector = {
    payload,
    signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64url'),
    launch: {
      title: 'Login fix',
      managedToolsFile,
      nativeOperationId,
      resultsFolder: join(state.home, 'session-results', requestId)
    }
  }
  return { keyFile, authenticate: () => authenticateSessionPrepConnector(connector, text, {}) }
}

afterEach(() => {
  vi.unstubAllEnvs()
  if (state.home) {
    rmSync(state.home, { recursive: true, force: true })
  }
  state.home = ''
})

it('authenticates with the default public key when the variable is unset', () => {
  const f = fixture()
  write(f.keyFile, publicPem)
  expect(f.authenticate().claims.operator).toBe('emp_sal')
})

it('refuses a missing default key file', () => {
  const f = fixture()
  expect(f.authenticate).toThrow(/ENOENT/)
})

it('refuses private key material at the default path', () => {
  const f = fixture()
  write(f.keyFile, privatePem)
  expect(f.authenticate).toThrow('public PEM key material only')
})

it('uses the explicit environment path even when the default contains private material', () => {
  const f = fixture()
  write(f.keyFile, privatePem)
  const override = join(state.home, 'explicit-verifier.pem')
  write(override, publicPem)
  vi.stubEnv('OMNI_SESSION_PREP_VERIFY_KEY_FILE', override)
  expect(f.authenticate().claims.operator).toBe('emp_sal')
})

it('does not fall back to a valid default when the explicit key is missing', () => {
  const f = fixture()
  write(f.keyFile, publicPem)
  vi.stubEnv('OMNI_SESSION_PREP_VERIFY_KEY_FILE', join(state.home, 'missing.pem'))
  expect(f.authenticate).toThrow(/ENOENT/)
})
