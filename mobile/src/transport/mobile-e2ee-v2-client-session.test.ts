import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { DesktopMobileE2EEV2Session } from '../../../src/main/runtime/rpc/mobile-e2ee-v2-desktop-session'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Ready
} from '../../../src/shared/mobile-e2ee-v2-contract'
import { sealMobileE2EEV2Frame } from '../../../src/shared/mobile-e2ee-v2-framing'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(9)
}))

import { deriveSharedKey } from './e2ee'
import { MobileE2EEV2ClientSession } from './mobile-e2ee-v2-client-session'
import { deriveMobileE2EEV2KeySchedule } from './mobile-e2ee-v2-key-schedule'

const desktop = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
const client = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2))

function setup() {
  const session = MobileE2EEV2ClientSession.create({
    desktopPublicKeyB64: Buffer.from(desktop.publicKey).toString('base64'),
    transport: 'relay',
    relayHostId: 'AbCdEf0123_-xyZ9',
    clientNonce: new Uint8Array(32).fill(3),
    clientKeyPair: client
  })
  const ready: MobileE2EEV2Ready = {
    type: 'e2ee_ready',
    v: 2,
    desktopPublicKeyB64: Buffer.from(desktop.publicKey).toString('base64'),
    clientNonceB64: session.hello.clientNonceB64,
    desktopNonceB64: Buffer.from(new Uint8Array(32).fill(4)).toString('base64'),
    selection: { framing: 2, payloadKinds: ['text', 'binary'] },
    context: session.hello.context
  }
  return { session, ready }
}

describe('mobile E2EE v2 client session', () => {
  it.each(['direct', 'relay'] as const)(
    'exchanges frames with the desktop using an existing pinned key over %s',
    (transport) => {
      const context = {
        transport,
        ...(transport === 'relay' ? { relayHostId: 'AbCdEf0123_-xyZ9' } : {})
      }
      const connect = (nonce: number) => {
        const mobile = MobileE2EEV2ClientSession.create({
          ...context,
          desktopPublicKeyB64: Buffer.from(desktop.publicKey).toString('base64'),
          clientNonce: new Uint8Array(32).fill(nonce),
          clientKeyPair: client
        })
        const host = DesktopMobileE2EEV2Session.create({
          hello: mobile.hello,
          serverSecretKey: desktop.secretKey,
          expectedContext: context,
          randomBytes: (length) => new Uint8Array(length).fill(4)
        })!
        expect(host).not.toBeNull()
        expect(mobile.acceptReady(host.ready)).toBe(true)
        expect(host.transcriptHashB64).toBe(mobile.transcriptHashB64)
        return { mobile, host }
      }

      const first = connect(3)
      const frame = first.mobile.sealText('existing pairing context')
      expect(first.host.openText(frame)).toBe('existing pairing context')
      expect(first.host.openText(frame)).toBeNull()
      expect(first.mobile.openText(first.host.sealText('received'))).toBe('received')
      const bytes = new Uint8Array([0, 1, 127, 255])
      expect(first.host.openBinary(first.mobile.sealBinary(bytes))).toEqual(bytes)
      expect(first.mobile.openBinary(first.host.sealBinary(bytes))).toEqual(bytes)

      const reconnected = connect(5)
      expect(reconnected.host.openText(frame)).toBeNull()
      expect(reconnected.host.openText(reconnected.mobile.sealText('reconnected'))).toBe(
        'reconnected'
      )
    }
  )

  it('pins the desktop key and accepts the exact transcript', () => {
    const { session, ready } = setup()
    expect(session.acceptReady(ready)).toBe(true)
    expect(session.transcriptHashB64).toHaveLength(44)
    expect(
      session.acceptReady({
        ...ready,
        desktopPublicKeyB64: Buffer.from(new Uint8Array(32).fill(8)).toString('base64')
      })
    ).toBe(false)
  })

  it('seals auth at counter zero and rejects replayed desktop frames', () => {
    const { session, ready } = setup()
    expect(session.acceptReady(ready)).toBe(true)
    const auth = JSON.stringify({
      type: 'e2ee_auth',
      v: 2,
      transcriptHashB64: session.transcriptHashB64,
      deviceToken: 'token'
    })
    const authFrame = Buffer.from(session.sealText(auth), 'base64')
    expect(authFrame.subarray(16, 24)).toEqual(Buffer.alloc(8, 0))

    const handshake = validateMobileE2EEV2Handshake(session.hello, ready)!
    const schedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret: deriveSharedKey(desktop.secretKey, client.publicKey),
      transcript: encodeMobileE2EEV2Transcript(handshake),
      clientNonce: handshake.clientNonce,
      desktopNonce: handshake.desktopNonce
    })
    const response = sealMobileE2EEV2Frame({
      payload: new TextEncoder().encode('authenticated'),
      key: schedule.desktopToMobileKey,
      sessionId: schedule.sessionId,
      direction: 'desktop-to-mobile',
      payloadKind: 'text',
      counter: 0n
    })
    const encoded = Buffer.from(response).toString('base64')
    expect(session.openText(encoded)).toBe('authenticated')
    expect(session.openText(encoded)).toBeNull()
  })
})
