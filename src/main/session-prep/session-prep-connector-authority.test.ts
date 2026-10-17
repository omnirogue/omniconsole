import { generateKeyPairSync, sign } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SESSION_PREP_PARAMS } from '../../shared/session-prep-types'
import type { SessionPrepConnector } from '../../shared/session-prep-connector'
import { authenticateSessionPrepConnector } from './session-prep-connector-authority'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const workRoot = resolve('fixture-work')
const workspace = join(workRoot, 'project')
const state = resolve('fixture-state')
const requestId = 'connector-request-1'
const nativeOperationId = `1760400000000-${'a'.repeat(32)}`
const verbatim = '  Fix "login".\nKeep this line exactly.  '
type Context = Parameters<typeof authenticateSessionPrepConnector>[2]

function fixture(overrides: Record<string, unknown> = {}) {
  const claims = {
    v: 1,
    aud: 'session-prep',
    raw: false,
    purpose: 'launch',
    nonce: 'e2b79bdd-907a-4f4e-ae34-a5f75c0ad520',
    operator: 'emp_sal',
    requestId,
    text: verbatim,
    workspace,
    title: 'Login fix',
    executionHost: 'macserver',
    issuedAt: 1_000,
    expiresAt: 1_300,
    provider: 'codex',
    model: 'gpt-6-luna',
    effort: 'medium',
    ...overrides
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const connector: SessionPrepConnector = {
    payload,
    signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64url'),
    launch: {
      title: 'Login fix',
      provider: 'codex',
      model: 'gpt-6-luna',
      effort: 'medium',
      resultsFolder: join(state, 'session-results', requestId),
      managedToolsFile: join(state, 'session-tools', requestId, 'descriptor.json'),
      nativeOperationId
    }
  }
  const descriptor = {
    operation_id: requestId,
    native_operation_id: nativeOperationId,
    principal: { employee_id: claims.operator }
  }
  const deps = {
    publicKey,
    now: 1_000,
    config: { execution_host: 'macserver', state_dir: state, workspace_roots: [workRoot] },
    realpath: vi.fn((path: string) => resolve(path)),
    descriptor: vi.fn(() => descriptor)
  }
  return {
    claims,
    connector,
    descriptor,
    deps,
    authenticate: (context: Context = {}, text = verbatim) =>
      authenticateSessionPrepConnector(connector, text, context, deps)
  }
}

describe('signed connector prep authority', () => {
  it.each(['界', '😀', '\u0001'])(
    'preserves a full-length encoded request containing %j',
    (character) => {
      const text = character.repeat(24_000 / Buffer.byteLength(character))
      const f = fixture({ text })
      expect(
        SESSION_PREP_PARAMS.request.safeParse({
          text,
          connector: f.connector,
          source: { worktreeId: 'folder:workspace', paneKey: 'connector:request', agent: 'codex' }
        }).success
      ).toBe(true)
      expect(f.authenticate({}, text).claims.text).toBe(text)
      const tooLong = fixture({ text: text + character })
      expect(
        SESSION_PREP_PARAMS.request.safeParse({
          text: text + character,
          connector: tooLong.connector,
          source: { worktreeId: 'folder:workspace', paneKey: 'connector:request', agent: 'codex' }
        }).success
      ).toBe(false)
      expect(() => tooLong.authenticate({}, text + character)).toThrow()
    }
  )

  it.each(['emp_sal', 'emp_eve', 'emp_uma'])('accepts signed operator %s', (operator) => {
    const f = fixture({ operator })
    expect(f.authenticate()).toMatchObject({
      claims: { operator, text: verbatim },
      workspace
    })
    expect(f.deps.descriptor).toHaveBeenCalledWith(f.connector.launch.managedToolsFile)
  })

  it('refuses missing verifier configuration without trusting local CLI identity', () => {
    const f = fixture()
    vi.stubEnv('OMNI_SESSION_PREP_VERIFY_KEY_FILE', '')
    try {
      expect(() => authenticateSessionPrepConnector(f.connector, verbatim, {})).toThrow(
        'not configured'
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each(['', 'not a public key'])('refuses malformed public key %j', (key) => {
    const f = fixture()
    f.deps.publicKey = key
    expect(f.authenticate).toThrow()
    expect(f.deps.realpath).not.toHaveBeenCalled()
  })

  it('refuses an unknown operator even with a valid signature', () => {
    expect(fixture({ operator: 'emp_intruder' }).authenticate).toThrow()
  })

  it('refuses a signature from a different Ed25519 signer', () => {
    const f = fixture()
    const forged = generateKeyPairSync('ed25519')
    f.connector.signature = sign(
      null,
      Buffer.from(f.connector.payload),
      forged.privateKey
    ).toString('base64url')
    expect(f.authenticate).toThrow('signature is invalid')
    expect(f.deps.descriptor).not.toHaveBeenCalled()
  })

  it('refuses an invalid signature', () => {
    const f = fixture()
    f.connector.signature = Buffer.alloc(64).toString('base64url')
    expect(f.authenticate).toThrow('signature is invalid')
  })

  it.each(['text', 'title', 'provider', 'model', 'effort', 'purpose'])(
    'refuses unsigned mutation of %s',
    (field) => {
      const f = fixture()
      f.connector.payload = Buffer.from(
        JSON.stringify({ ...f.claims, [field]: 'forged' })
      ).toString('base64url')
      expect(f.authenticate).toThrow('signature is invalid')
    }
  )

  it('binds the exact submitted text including whitespace', () => {
    const f = fixture()
    expect(() => f.authenticate({}, verbatim.trim())).toThrow('request binding is invalid')
  })

  it('requires the signed purpose to match launch or status transport', () => {
    const launch = fixture()
    launch.connector.statusOnly = true
    expect(launch.authenticate).toThrow('request binding is invalid')
    const status = fixture({ purpose: 'status' })
    expect(status.authenticate).toThrow('request binding is invalid')
    status.connector.statusOnly = true
    expect(status.authenticate().digest).toBe(fixture().authenticate().digest)
  })

  it('refuses an assertion without a signed purpose', () => {
    expect(fixture({ purpose: undefined }).authenticate).toThrow()
  })

  it.each([
    ['title', 'Different task'],
    ['provider', 'claude'],
    ['model', 'gpt-6-astra'],
    ['effort', 'high']
  ] as const)('refuses a launch %s that differs from the signed choice', (field, value) => {
    const f = fixture()
    Object.assign(f.connector.launch, { [field]: value })
    expect(f.authenticate).toThrow('launch choice differs')
  })

  it('refuses a different execution host', () => {
    expect(fixture({ executionHost: 'other-mac' }).authenticate).toThrow(
      'request binding is invalid'
    )
  })

  it.each([join(workRoot, '..', 'other'), `${workRoot}-lookalike`])(
    'refuses workspace outside the configured roots: %s',
    (path) => {
      expect(fixture({ workspace: path }).authenticate).toThrow('outside the configured work roots')
    }
  )

  it('resolves symlinks before checking the workspace boundary', () => {
    const f = fixture()
    f.deps.realpath.mockImplementation((path) =>
      path === workspace ? resolve('escaped') : resolve(path)
    )
    expect(f.authenticate).toThrow('outside the configured work roots')
  })

  it('expands a home-relative workspace before checking roots', () => {
    const f = fixture({ workspace: '~/fixture-project' })
    f.deps.config.workspace_roots = [homedir()]
    expect(f.authenticate().workspace).toBe(join(homedir(), 'fixture-project'))
  })

  it.each(['resultsFolder', 'managedToolsFile'] as const)(
    'refuses changed host-owned %s',
    (field) => {
      const f = fixture()
      f.connector.launch[field] = join(state, 'other-operation')
      expect(f.authenticate).toThrow('launch files differ')
    }
  )

  it.each(['operation_id', 'native_operation_id', 'operator'])(
    'refuses descriptor %s mismatch',
    (field) => {
      const f = fixture()
      if (field === 'operator') {
        f.descriptor.principal.employee_id = 'emp_eve'
      } else {
        Object.assign(f.descriptor, { [field]: 'different-operation' })
      }
      expect(f.authenticate).toThrow('tool authority differs')
    }
  )

  it.each([
    { issuedAt: 1_031, expiresAt: 1_300 },
    { issuedAt: 1_000, expiresAt: 1_301 },
    { issuedAt: 1_000, expiresAt: 1_000 }
  ])('refuses invalid issuance/TTL %j', (claims) => {
    expect(fixture(claims).authenticate).toThrow('request binding is invalid')
  })

  it('allows the exact future skew boundary and refuses expired assertions', () => {
    expect(fixture({ issuedAt: 1_030 }).authenticate().claims.issuedAt).toBe(1_030)
    const f = fixture()
    f.deps.now = 1_300
    expect(f.authenticate).toThrow('binding is invalid')
  })

  it.each([true, undefined])('refuses raw=%s in a prepared assertion', (raw) => {
    expect(fixture({ raw }).authenticate).toThrow()
  })

  it('retains the durable digest when only a signed lease is renewed', () => {
    const before = fixture().authenticate()
    const after = fixture({ issuedAt: 1_010, expiresAt: 1_310 }).authenticate()
    expect(after.digest).toBe(before.digest)
  })

  it.each(['orchestrationCapability', 'orchestrationCompatibilityEvidence', 'unattendedCaller'])(
    'refuses signed caller with %s',
    (field) => {
      const f = fixture()
      const context = {
        [field]: field === 'orchestrationCapability' ? 'worker-capability' : {}
      } as Context
      expect(() => f.authenticate(context)).toThrow('Agents and workers cannot start')
      expect(f.deps.realpath).not.toHaveBeenCalled()
    }
  )

  it('preserves the request through RPC parsing before signature validation', () => {
    const f = fixture()
    const parsed = SESSION_PREP_PARAMS.request.parse({
      text: verbatim,
      connector: f.connector,
      source: { worktreeId: 'folder:workspace', paneKey: 'connector:request', agent: 'codex' }
    })
    expect(parsed.text).toBe(verbatim)
    expect(f.authenticate({}, parsed.text).claims.text).toBe(verbatim)
    expect(SESSION_PREP_PARAMS.request.safeParse({ ...parsed, text: ' \n ' }).success).toBe(false)
  })
})
