import { generateKeyPairSync } from 'node:crypto'
import type * as NodeFs from 'node:fs'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  authenticateSessionPrepConnector,
  readSessionPrepVerificationKey
} from './session-prep-connector-authority'

const fileState = vi.hoisted(() => ({ foreignOwner: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    fstatSync: (fd: number) => {
      const stat = actual.fstatSync(fd)
      if (fileState.foreignOwner) {
        stat.uid += 1
      }
      return stat
    }
  }
})

const keys = generateKeyPairSync('ed25519')
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const homes: string[] = []
function fixture(contents = publicPem) {
  const home = mkdtempSync(join(tmpdir(), 'prep-verifier-'))
  homes.push(home)
  chmodSync(home, 0o700)
  const file = join(home, 'verify.pem')
  writeFileSync(file, contents, { mode: 0o600 })
  return { home, file, read: () => readSessionPrepVerificationKey(file, home) }
}
afterEach(() => {
  vi.restoreAllMocks()
  fileState.foreignOwner = false
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})
it('accepts only public key material from a current-user-owned 0600 verifier file', () => {
  expect(fixture().read()).toBe(publicPem)
})
it.each([privatePem, `${publicPem}\n${privatePem}`])('refuses private PEM material', (pem) => {
  expect(fixture(pem).read).toThrow('public PEM key material only')
})
it('also refuses dependency-injected private material before signature verification', () => {
  expect(() =>
    authenticateSessionPrepConnector(
      {} as never,
      '',
      {},
      {
        publicKey: privatePem,
        config: { execution_host: 'local', state_dir: '/state', workspace_roots: [] },
        now: 0,
        realpath: vi.fn(),
        descriptor: vi.fn()
      }
    )
  ).toThrow('public PEM key material only')
})
it.each([0o620, 0o602, 0o666, 0o644])('refuses verifier file mode %i', (mode) => {
  const f = fixture()
  chmodSync(f.file, mode)
  expect(f.read).toThrow('managed_session_tools_file_untrusted')
})
it('refuses a symlink to an otherwise trusted verifier', () => {
  const f = fixture()
  const linked = join(f.home, 'linked.pem')
  symlinkSync(f.file, linked)
  expect(() => readSessionPrepVerificationKey(linked, f.home)).toThrow()
})
it('refuses a verifier owned by a different OS user without changing ownership', () => {
  const f = fixture()
  fileState.foreignOwner = true
  expect(f.read).toThrow('managed_session_tools_file_untrusted')
})
it('refuses a verifier beneath a group-writable directory', () => {
  const f = fixture()
  chmodSync(f.home, 0o720)
  expect(f.read).toThrow('managed_session_tools_file_untrusted')
})
