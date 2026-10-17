import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import nacl from 'tweetnacl'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MOBILE_E2EE_V2_VECTOR } from '../../src/shared/mobile-e2ee-v2-fixtures'

import type { DesktopMobileE2EEV2Session } from '../../src/main/runtime/rpc/mobile-e2ee-v2-desktop-session'
import type { MobileE2EEV2Hello } from '../../src/shared/mobile-e2ee-v2-contract'

type MobilePeer = Pick<
  DesktopMobileE2EEV2Session,
  'sealText' | 'sealBinary' | 'openText' | 'openBinary' | 'transcriptHashB64'
> & {
  hello: MobileE2EEV2Hello
  acceptReady: (value: unknown) => boolean
}
type Fixture = {
  DesktopMobileE2EEV2Session: typeof DesktopMobileE2EEV2Session
  MobileE2EEV2ClientSession: {
    create: (args: {
      desktopPublicKeyB64: string
      transport: 'direct' | 'relay'
      relayHostId?: string
      clientNonce: Uint8Array
      clientKeyPair: nacl.BoxKeyPair
    }) => MobilePeer
  }
  normativeSchedules: () => Record<string, Uint8Array>[]
}
let fixture: Fixture
let directory: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mobile-wire-compatibility-'))
  const output = join(directory, 'peers.cjs')
  const mobilePackage = JSON.parse(readFileSync(resolve('mobile/package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  const hashVersion = mobilePackage.dependencies['@noble/hashes']
  const hashes = resolve(
    `node_modules/.pnpm/@noble+hashes@${hashVersion}/node_modules/@noble/hashes`
  )
  expect(JSON.parse(readFileSync(join(hashes, 'package.json'), 'utf8')).version).toBe(hashVersion)
  // Bundle the real independent peers; only Expo's native RNG is replaced, and any use fails.
  await build({
    stdin: {
      contents: `
        export { MobileE2EEV2ClientSession } from './mobile/src/transport/mobile-e2ee-v2-client-session'
        export { DesktopMobileE2EEV2Session } from './src/main/runtime/rpc/mobile-e2ee-v2-desktop-session'
        import { deriveMobileE2EEV2KeySchedule as mobile } from './mobile/src/transport/mobile-e2ee-v2-key-schedule'
        import { deriveMobileE2EEV2KeySchedule as desktop } from './src/main/runtime/rpc/mobile-e2ee-v2-key-schedule'
        import { createMobileE2EEV2Fixture } from './src/shared/mobile-e2ee-v2-fixtures'
        import { encodeMobileE2EEV2Transcript, validateMobileE2EEV2Handshake } from './src/shared/mobile-e2ee-v2-contract'
        export function normativeSchedules() {
          const {hello, ready, sharedSecret} = createMobileE2EEV2Fixture()
          const handshake = validateMobileE2EEV2Handshake(hello, ready)
          const input = {sharedSecret, transcript: encodeMobileE2EEV2Transcript(handshake),
            clientNonce: handshake.clientNonce, desktopNonce: handshake.desktopNonce}
          return [mobile(input), desktop(input)]
        }
      `,
      resolveDir: resolve('.'),
      loader: 'ts'
    },
    alias: { '@noble/hashes': hashes },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: output,
    tsconfigRaw: { compilerOptions: {} },
    plugins: [
      {
        name: 'injected-test-nonces-only',
        setup(builder) {
          builder.onResolve({ filter: /^expo-crypto$/ }, () => ({
            path: 'rng',
            namespace: 'test-rng'
          }))
          builder.onLoad({ filter: /.*/, namespace: 'test-rng' }, () => ({
            contents:
              'export function getRandomBytes() { throw new Error("Unexpected native RNG use") }'
          }))
        }
      }
    ]
  })
  fixture = createRequire(import.meta.url)(output) as Fixture
})

afterAll(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

const desktopKeys = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
const mobileKeys = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2))
const relayHostId = 'AbCdEf0123_-xyZ9'

function peers(transport: 'direct' | 'relay', pinnedKey = desktopKeys.publicKey) {
  const mobile = fixture.MobileE2EEV2ClientSession.create({
    desktopPublicKeyB64: Buffer.from(pinnedKey).toString('base64'),
    transport,
    ...(transport === 'relay' ? { relayHostId } : {}),
    clientNonce: new Uint8Array(32).fill(3),
    clientKeyPair: mobileKeys
  })
  const desktop = fixture.DesktopMobileE2EEV2Session.create({
    hello: mobile.hello,
    serverSecretKey: desktopKeys.secretKey,
    expectedContext: { transport, ...(transport === 'relay' ? { relayHostId } : {}) },
    randomBytes: () => new Uint8Array(32).fill(4)
  })
  expect(desktop).not.toBeNull()
  return { mobile, desktop: desktop! }
}

describe('actual mobile and desktop E2EE v2 wire compatibility', () => {
  it('preserves both independent implementations of the established normative vector', () => {
    for (const schedule of fixture.normativeSchedules()) {
      for (const field of [
        'mobileToDesktopKey',
        'desktopToMobileKey',
        'sessionId',
        'transcriptHash'
      ] as const) {
        expect(Buffer.from(schedule[field]).toString('hex')).toBe(
          MOBILE_E2EE_V2_VECTOR[`${field}Hex`]
        )
      }
    }
  })

  it.each(['direct', 'relay'] as const)(
    'exchanges authenticated text and binary with actual %s peers',
    (transport) => {
      const { mobile, desktop } = peers(transport)
      expect(mobile.hello.context.protocol).toBe('orca-mobile-e2ee')
      expect(mobile.acceptReady(desktop.ready)).toBe(true)
      expect(mobile.transcriptHashB64).toBe(desktop.transcriptHashB64)
      const auth = JSON.stringify({
        type: 'e2ee_auth',
        v: 2,
        transcriptHashB64: mobile.transcriptHashB64,
        deviceToken: 'synthetic-token'
      })
      const first = mobile.sealText(auth)
      expect(desktop.openText(first)).toBe(auth)
      expect(desktop.openText(first)).toBeNull()
      const response = desktop.sealText('authenticated')
      expect(mobile.openText(response)).toBe('authenticated')
      expect(mobile.openText(response)).toBeNull()
      expect(desktop.openBinary(mobile.sealBinary(new Uint8Array([1, 2, 3])))).toEqual(
        new Uint8Array([1, 2, 3])
      )
      expect(mobile.openBinary(desktop.sealBinary(new Uint8Array([4, 5])))).toEqual(
        new Uint8Array([4, 5])
      )
    }
  )

  it('rejects the wrong desktop identity and changed echoed context', () => {
    const otherKey = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(8)).publicKey
    const wrongPin = peers('relay', otherKey)
    expect(wrongPin.mobile.acceptReady(wrongPin.desktop.ready)).toBe(false)
    const { mobile, desktop } = peers('relay')
    expect(
      mobile.acceptReady({
        ...desktop.ready,
        context: { ...desktop.ready.context, relayHostId: 'ZbCdEf0123_-xyZ9' }
      })
    ).toBe(false)
    expect(
      mobile.acceptReady({
        ...desktop.ready,
        context: { ...desktop.ready.context, protocol: 'omni-mobile-e2ee' }
      })
    ).toBe(false)
    expect(mobile.acceptReady(desktop.ready)).toBe(true)
    const damaged = mobile.sealBinary(new Uint8Array([7]))
    damaged[damaged.length - 1] ^= 1
    expect(desktop.openBinary(damaged)).toBeNull()
  })
})
