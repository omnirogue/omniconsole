/**
 * The owner computer's half of waking elsewhere (OAOS-12 Phase 2), run by the 60-second review
 * pass: a wait asleep on its review, with nothing running it, gets one copy on OmniOS for its
 * revision (or a fixed word for why it cannot move); a copy whose session runs here again, or woke,
 * is withdrawn until OmniOS confirms it is gone, so another computer can never take it.
 */

import { wakeCopyMayExist, type ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import { activeRuntimeSessionHost } from '../session-host/session-host-runtime'
import { getSessionWrittenFilesStore } from './session-written-files-store'
import type { ReviewSleepEntry } from './artifact-review-sleep-targets'
import { reviewHostLabel } from './artifact-source-state-report'
import { uploadWakeCopy, withdrawWakeCopy, type WakeCopyApi } from './review-wake-copy-api'
import { buildWakeCopy } from './review-wake-copy-source'

const RETRY_MS = 30 * 60_000
/** Refusals that cannot change while the session sleeps are not built again. */
const FINAL_REFUSALS = new Set(['too large', 'outside Work'])

type WakeCopy = NonNullable<ArtifactReviewSleep['wakeCopy']>

/** This computer as OmniOS knows it: its session-host id and its sharing name. */
export async function reviewHost(): Promise<{ hostId: string; host: string } | null> {
  const hostId = activeRuntimeSessionHost()?.current()?.identity.hostId
  return hostId ? { hostId, host: await reviewHostLabel() } : null
}

function needsCopy(sleep: ArtifactReviewSleep, now: number): boolean {
  const copy = sleep.wakeCopy?.revision === sleep.revision ? sleep.wakeCopy : undefined
  if (!copy) {
    return true
  }
  if (copy.sha256) {
    return false
  }
  return !(copy.refused && FINAL_REFUSALS.has(copy.refused)) && now - copy.at >= RETRY_MS
}

export function createWakeCopyUploads(input: {
  api: WakeCopyApi
  entries(): ReviewSleepEntry[]
  saveWakeCopy(entry: ReviewSleepEntry, wakeCopy: WakeCopy): boolean
  /** It ran here again after it slept: never copied again for this revision. */
  markReopened(entry: ReviewSleepEntry): boolean
  /** A live pane holds the conversation; null when that cannot be told. */
  running(entry: ReviewSleepEntry, sleptAt: number | undefined): Promise<boolean | null>
  beat(): Promise<void>
  now(): number
}): () => Promise<void> {
  let unsupportedUntil = 0
  const withdraw = async (entry: ReviewSleepEntry): Promise<boolean> => {
    if ((await withdrawWakeCopy(input.api, entry.slug)) !== 'ok') {
      return false
    }
    return input.saveWakeCopy(entry, { revision: entry.sleep.revision, at: input.now() })
  }
  return async () => {
    const now = input.now()
    for (const entry of input.entries()) {
      const { sleep } = entry
      const current = sleep.revision === entry.sourceReview.revision
      // Why every pass until OmniOS answers: a copy left up could be woken a second time elsewhere.
      if ((sleep.state === 'awake' || sleep.state === 'waiting') && wakeCopyMayExist(sleep)) {
        await withdraw(entry)
        continue
      }
      if (sleep.state !== 'asleep' || !current) {
        continue
      }
      const running = await input.running(entry, sleep.sleptAt)
      if (running) {
        if (!sleep.reopened && (!wakeCopyMayExist(sleep) || (await withdraw(entry)))) {
          input.markReopened(entry)
        }
        continue
      }
      if (running === null || sleep.reopened || now < unsupportedUntil || !needsCopy(sleep, now)) {
        continue
      }
      const host = await reviewHost()
      if (!host) {
        return
      }
      // Building can take a while; OmniOS must not see this computer as gone meanwhile.
      await input.beat()
      const sessionId = entry.sourceReview.nativeSessionId
      const built = await buildWakeCopy({
        slug: entry.slug,
        title: entry.title ?? null,
        sessionId,
        sleep,
        host: host.host,
        writtenPaths: getSessionWrittenFilesStore()?.pathsFor(sleep.provider, sessionId) ?? []
      }).catch(() => ({ refused: 'could not verify' as const }))
      const base = { revision: sleep.revision, at: now }
      if ('refused' in built) {
        input.saveWakeCopy(entry, { ...base, refused: built.refused })
        continue
      }
      // Why pending first: once `complete` may have landed, a lost reply still counts as a copy.
      if (!input.saveWakeCopy(entry, { ...base, pending: true })) {
        continue
      }
      const sent = await uploadWakeCopy(input.api, {
        slug: entry.slug,
        copy: built,
        ...host,
        beat: input.beat
      })
      if (sent.status === 'unsupported') {
        unsupportedUntil = now + RETRY_MS
        input.saveWakeCopy(entry, { ...base, refused: 'not available yet' })
        return
      }
      input.saveWakeCopy(
        entry,
        sent.status === 'ok'
          ? { ...base, sha256: built.sha256 }
          : { ...base, refused: 'could not verify', pending: true }
      )
    }
  }
}
