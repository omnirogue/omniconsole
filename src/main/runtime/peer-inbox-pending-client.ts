import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { readNodeFileHandleWithinLimit } from '../../shared/node-bounded-file-reader'

const TOKEN_BYTES_LIMIT = 4096
const RESPONSE_BYTES_LIMIT = 64 * 1024
const REQUEST_TIMEOUT_MS = 5000

export type PeerInboxPendingClientConfig = Readonly<{
  apiOrigin: string
  tokenFile: string
}>

export type PeerInboxPendingClientOptions = Readonly<{
  signal?: AbortSignal
  fetch?: typeof globalThis.fetch
}>

export type PeerInboxPendingClientErrorCode =
  | 'invalid_origin'
  | 'invalid_token_file'
  | 'request_aborted'
  | 'request_timeout'
  | 'request_failed'
  | 'http_error'
  | 'response_too_large'
  | 'invalid_response'

export class PeerInboxPendingClientError extends Error {
  constructor(readonly code: PeerInboxPendingClientErrorCode) {
    super(`Peer inbox pending request failed (${code}).`)
    this.name = 'PeerInboxPendingClientError'
  }
}

function pendingUrl(apiOrigin: string): string {
  try {
    const url = new URL(apiOrigin)
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '[::1]' ||
      (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'))
    if (
      apiOrigin !== url.origin ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    ) {
      throw new Error('Invalid origin')
    }
    return `${url.origin}/api/session-peers/agent`
  } catch {
    throw new PeerInboxPendingClientError('invalid_origin')
  }
}

function assertPrivateRegularFile(stats: Stats): void {
  if (
    !stats.isFile() ||
    (process.platform !== 'win32' &&
      ((stats.mode & 0o7777) !== 0o600 || stats.uid !== process.getuid?.()))
  ) {
    throw new PeerInboxPendingClientError('invalid_token_file')
  }
}

async function readToken(tokenFile: string): Promise<string> {
  try {
    if (!isAbsolute(tokenFile)) {
      throw new Error('Invalid token path')
    }
    const before = await lstat(tokenFile)
    assertPrivateRegularFile(before)
    const handle = await open(
      tokenFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    try {
      const opened = await handle.stat()
      assertPrivateRegularFile(opened)
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error('Token file changed')
      }
      const { buffer } = await readNodeFileHandleWithinLimit(handle, TOKEN_BYTES_LIMIT)
      let token: string
      try {
        token = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/\r?\n$/, '')
      } finally {
        buffer.fill(0)
      }
      const after = await lstat(tokenFile)
      assertPrivateRegularFile(after)
      assertPrivateRegularFile(await handle.stat())
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        !/^[A-Za-z0-9._~+/-]+=*$/.test(token)
      ) {
        throw new Error('Invalid token')
      }
      return token
    } finally {
      await handle.close()
    }
  } catch {
    throw new PeerInboxPendingClientError('invalid_token_file')
  }
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > RESPONSE_BYTES_LIMIT
  ) {
    void response.body?.cancel().catch(() => undefined)
    throw new PeerInboxPendingClientError('response_too_large')
  }
  if (!response.body) {
    throw new PeerInboxPendingClientError('invalid_response')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) {
    cancel()
  }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        complete = true
        break
      }
      total += chunk.value.byteLength
      if (total > RESPONSE_BYTES_LIMIT) {
        throw new PeerInboxPendingClientError('response_too_large')
      }
      chunks.push(chunk.value)
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    } catch {
      throw new PeerInboxPendingClientError('invalid_response')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!complete) {
      cancel()
    }
    reader.releaseLock()
  }
}

// The execution-host owner supplies this config; the client never discovers or copies credentials.
export async function readPeerInboxPending(
  config: PeerInboxPendingClientConfig,
  options: PeerInboxPendingClientOptions = {}
): Promise<unknown> {
  const url = pendingUrl(config.apiOrigin)
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) {
    abort()
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  timer.unref()
  let rejectAborted: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () =>
      reject(new PeerInboxPendingClientError(timedOut ? 'request_timeout' : 'request_aborted'))
    controller.signal.addEventListener('abort', rejectAborted, { once: true })
    if (controller.signal.aborted) {
      rejectAborted()
    }
  })
  const request = async () => {
    if (controller.signal.aborted) {
      throw new PeerInboxPendingClientError('request_aborted')
    }
    const token = await readToken(config.tokenFile)
    if (controller.signal.aborted) {
      throw new PeerInboxPendingClientError('request_aborted')
    }
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ action: 'pending', parameters: {} }),
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal
    })
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => undefined)
      throw new PeerInboxPendingClientError('http_error')
    }
    return await readResponse(response, controller.signal)
  }
  try {
    return await Promise.race([request(), aborted])
  } catch (error) {
    if (controller.signal.aborted) {
      throw new PeerInboxPendingClientError(timedOut ? 'request_timeout' : 'request_aborted')
    }
    if (error instanceof PeerInboxPendingClientError) {
      throw error
    }
    throw new PeerInboxPendingClientError('request_failed')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    if (rejectAborted) {
      controller.signal.removeEventListener('abort', rejectAborted)
    }
  }
}
