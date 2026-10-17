import { z } from 'zod'
import { readFetchResponseBytesWithinLimit } from '../../shared/fetch-response-body'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { advertisingTarget, type AdvertisingTarget } from '../../shared/typesafe-advertising'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { getMainHttpClient } from '../network/http-client'
import { OLDACS_ACCOUNT_ID, OLDACS_COMPANY } from './typesafe-advertising-local-scope'

export type LocalMetaStatusWriterIdentity = {
  token: string
  isCurrent: () => boolean
  assertCurrent: () => Promise<void>
}
export type LocalMetaStatusWriterOptions = { fetch?: typeof globalThis.fetch; now?: () => number }
export type LocalMetaStatusResult = {
  accepted: true
  reference: string | null
  respondedAt: string
}
export type LocalMetaStatusWriter = {
  send(target: AdvertisingTarget, status: 'ACTIVE' | 'PAUSED'): Promise<LocalMetaStatusResult>
}

const MESSAGE = 'Local Meta status change is unverified.'
const REQUEST_MS = 10_000
const BODY_BYTES = 64 * 1024
const nativeId = /^[1-9][0-9]{4,29}$/
const statusSchema = z.enum(['ACTIVE', 'PAUSED'])
const responseSchema = z
  .object({
    success: z.literal(true),
    fbtrace_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .optional()
  })
  .strict()

function unverified(): never {
  throw new Error(MESSAGE)
}

function requestUrl(target: AdvertisingTarget): string {
  const parsed = advertisingTarget.safeParse(target)
  if (!parsed.success) {
    unverified()
  }
  const value = parsed.data
  if (
    value.company !== OLDACS_COMPANY ||
    value.accountId !== OLDACS_ACCOUNT_ID ||
    value.objectType === 'campaign' ||
    value.adsetId === null ||
    ![value.nativeId, value.campaignId, value.adsetId].every((id) => nativeId.test(id)) ||
    [value.nativeId, value.campaignId, value.adsetId].includes(OLDACS_ACCOUNT_ID.slice(4)) ||
    value.campaignId === value.adsetId ||
    (value.objectType === 'ad' &&
      (value.nativeId === value.campaignId || value.nativeId === value.adsetId))
  ) {
    unverified()
  }
  return `https://graph.facebook.com/v21.0/${value.nativeId}`
}

export function createLocalMetaStatusWriter(
  identity: LocalMetaStatusWriterIdentity,
  options: LocalMetaStatusWriterOptions = {}
): LocalMetaStatusWriter {
  const { token, isCurrent, assertCurrent } = identity
  const http = getMainHttpClient()
  const fetcher = options.fetch ?? http.fetch.bind(http)
  const now = options.now ?? Date.now
  let used = false

  return {
    async send(target, status) {
      if (used) {
        unverified()
      }
      // A rejected or uncertain attempt cannot be retried through this capability.
      used = true
      const controller = new AbortController()
      let response: Response | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let stopped = false
      let deadline = 0
      function check(): void {
        const current = now()
        if (
          stopped ||
          controller.signal.aborted ||
          !Number.isFinite(deadline) ||
          !Number.isFinite(current) ||
          current >= deadline ||
          !isCurrent()
        ) {
          unverified()
        }
      }
      try {
        deadline = now() + REQUEST_MS
        const url = requestUrl(target)
        const selectedStatus = statusSchema.safeParse(status)
        if (
          !selectedStatus.success ||
          typeof token !== 'string' ||
          !/^[A-Za-z0-9._~-]{1,4096}$/.test(token)
        ) {
          unverified()
        }
        const request: RequestInit = {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          body: new URLSearchParams({ status: selectedStatus.data }),
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          signal: controller.signal
        }
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            stopped = true
            controller.abort()
            reject(new Error(MESSAGE))
          }, REQUEST_MS)
        })
        const write = async (): Promise<LocalMetaStatusResult> => {
          check()
          await assertCurrent()
          // No awaited helper may separate this fence from the single native write.
          check()
          response = await fetcher(url, request)
          try {
            check()
            await assertCurrent()
            check()
            if (!response.ok || response.redirected || (response.url && response.url !== url)) {
              unverified()
            }
            const bytes = await readFetchResponseBytesWithinLimit(response, BODY_BYTES)
            check()
            await assertCurrent()
            check()
            const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            assertJsonTextStructureWithinLimits(content, { structuralTokens: 16, nestingDepth: 4 })
            const parsed = responseSchema.safeParse(JSON.parse(content))
            if (!parsed.success || parsed.data.fbtrace_id?.includes(token)) {
              unverified()
            }
            // Reject duplicate keys and ambiguous escaped spellings in this tiny contract.
            const compact = content.replace(/[ \t\r\n]/g, '')
            const reversed = { fbtrace_id: parsed.data.fbtrace_id, success: true }
            if (compact !== JSON.stringify(parsed.data) && compact !== JSON.stringify(reversed)) {
              unverified()
            }
            const result: LocalMetaStatusResult = {
              accepted: true,
              reference: parsed.data.fbtrace_id ?? null,
              respondedAt: new Date(now()).toISOString()
            }
            check()
            return result
          } finally {
            void cancelUnreadResponseBody(response)
          }
        }
        const result = await Promise.race([write(), timeout])
        check()
        return result
      } catch {
        stopped = true
        controller.abort()
        unverified()
      } finally {
        stopped = true
        if (timer !== undefined) {
          clearTimeout(timer)
        }
        if (response) {
          void cancelUnreadResponseBody(response)
        }
      }
    }
  }
}
