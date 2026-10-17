/**
 * How a relocation's files travel from the source's export folder to the destination's staging
 * folder. The requesting computer moves them (hosts never talk to each other): chunk by chunk
 * through each host's own session host methods, resuming from what the destination already holds.
 * Staging then checks every byte against the manifest, so a channel can fail but never corrupt a
 * move silently; a copy that cannot finish is reported, and the move stops before relinquishment.
 */

import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionHostRelocationProvider } from '../../shared/session-host-capabilities'
import { isRelocationManifestPath } from '../../shared/session-host-payload-schema'
import { RELOCATION_BUNDLE_CHUNK_BYTES } from '../../shared/session-host-relocation-bundle'
import type { SessionTransferHostPort } from './session-transfer-host-port'

export type SessionRelocationBundleCopy = {
  source: SessionTransferHostPort
  /** The source's export folder, as its `relocate.export` result named it. */
  from: string
  destination: SessionTransferHostPort
  /** The destination's staging folder, as its `relocate.prepare-destination` result named it. */
  to: string
  /** The manifest's files: relative, non-escaping paths and their exact sizes. */
  files: readonly { path: string; bytes: number }[]
  relocation: string
  conversationId: string
  provider: SessionHostRelocationProvider
}

export type SessionRelocationBundleChannel = {
  copy(input: SessionRelocationBundleCopy): Promise<void>
}

/** Both hosts on this computer's own disk (tests, and two accounts on one machine). */
export const SAME_DISK_RELOCATION_CHANNEL: SessionRelocationBundleChannel = {
  async copy({ from, to, files }) {
    for (const { path } of files) {
      if (!isRelocationManifestPath(path)) {
        throw new Error(`${path} would leave the bundle.`)
      }
      const target = join(to, ...path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(from, ...path.split('/')), target, { force: true })
    }
  }
}

const LOST = new Set(['host-unreachable', 'renegotiate'])

type Reply<T> = T | { status: 'refused'; refusal: { code: string; message: string } }

/** A lost reply is asked again (reads and positional writes are safe to repeat); nothing else. */
async function withRetries<T extends { status: string }>(
  call: () => Promise<Reply<T>>,
  what: string,
  options: { attempts: number; sleep: (ms: number) => Promise<void> }
): Promise<Extract<T, { status: 'ok' }>> {
  for (let attempt = 1; ; attempt += 1) {
    const reply = await call()
    if (reply.status === 'ok') {
      return reply as Extract<T, { status: 'ok' }>
    }
    const { refusal } = reply as { refusal: { code: string; message: string } }
    if (!LOST.has(refusal.code) || attempt >= options.attempts) {
      throw new Error(`${what}: ${refusal.message}`)
    }
    await options.sleep(attempt * 1_000)
  }
}

/** Through each host's session host methods; the usual channel between two computers. */
export function sessionHostRelocationChannel(
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}
): SessionRelocationBundleChannel {
  const retry = {
    attempts: options.attempts ?? 4,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  }
  return {
    async copy(input) {
      const { source, destination, relocation, conversationId, provider } = input
      const bundle = { relocation, conversationId, provider }
      for (const file of [...input.files].sort((a, b) => a.path.localeCompare(b.path))) {
        const write = (offset: number, base64: string) =>
          withRetries(
            () =>
              destination.relocationBundleWrite({
                ...bundle,
                path: file.path,
                offset,
                size: file.bytes,
                base64
              }),
            `${destination.label} did not take ${file.path}`,
            retry
          )
        // Why an empty write first: it creates the file and says how much a resumed copy holds.
        let received = (await write(0, '')).received
        if (received > file.bytes) {
          throw new Error(`${destination.label} holds more of ${file.path} than the bundle has.`)
        }
        while (received < file.bytes) {
          const chunk = await withRetries(
            () =>
              source.relocationBundleRead({
                ...bundle,
                path: file.path,
                offset: received,
                length: Math.min(RELOCATION_BUNDLE_CHUNK_BYTES, file.bytes - received)
              }),
            `${source.label} did not give ${file.path}`,
            retry
          )
          if (!chunk.base64) {
            throw new Error(`${source.label} ended ${file.path} early.`)
          }
          const written = await write(received, chunk.base64)
          if (!written.accepted && written.received <= received) {
            throw new Error(`${destination.label} holds different bytes of ${file.path}.`)
          }
          received = written.received
        }
      }
    }
  }
}
