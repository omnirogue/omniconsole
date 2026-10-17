/**
 * The other computer's half of waking elsewhere (PLAN section 4, OAOS-12 Phase 2): when a decision
 * lands on a page whose session sleeps on a computer that is off, this computer (the decider's, or
 * the publisher's always-on one) claims the wake on OmniOS, downloads and checks the copy, stages
 * it with relocate's import under this computer's best verified account, prepares the workspace,
 * resumes the same conversation id, delivers the decision with a line saying it moved, and marks
 * the claim done. Every claim is journaled before it is made and ends released or done: released
 * while nothing started, done once a terminal may run it, so it never runs twice or sticks.
 */

import { compareProviderVersions } from '../session-relocation/relocation-provider-adapter'
import type { StagedRelocation } from '../session-relocation/relocation-bundle-import'
import type { WakeCopyApiResult } from './review-wake-copy-api'
import type { WakeCopyHeader, WakeCopyWorkspace } from './review-wake-copy-pack'
import { validCandidate, type WakeCandidate } from './review-wake-candidate'

export type { WakeCandidate } from './review-wake-candidate'
import type { ClaimerWorkspace } from './review-wake-claimer-workspace'
import { confirmDone, release, settleClaims } from './review-wake-claim-settle'

export type ReleaseReason =
  | 'cannot run here'
  | 'could not start'
  | 'download failed'
  | 'could not verify'

/** A step that failed before any terminal started; the claim is released with this word. */
export class ClaimerStepError extends Error {
  constructor(
    message: string,
    readonly release: ReleaseReason,
    /** The same answer would come back for this decision (no account fits, launches run in WSL). */
    readonly final = false
  ) {
    super(message)
  }
}

/** Kept on disk per page: a claim this computer makes or holds and how far its wake got. */
export type ClaimRecord = {
  revision: number
  decisionId: string
  /**
   * `claiming` before the request (it may have won); `releasing` until OmniOS confirms;
   * `launching` once a terminal may start; `moved` until OmniOS confirms done.
   */
  phase: 'claiming' | 'claimed' | 'releasing' | 'launching' | 'moved' | 'done' | 'failed'
  at: number
  release?: ReleaseReason
  /** Not claimed again for this decision: the same refusal would repeat. */
  final?: true
  provider?: 'claude' | 'codex'
  sessionId?: string
  reason?: string
}

export type ClaimerHost = { hostId: string; host: string }

export type WakeClaimerDeps = {
  /** The relocation switch: off as a requester means off as a claimer too. */
  enabled(): boolean
  candidates(): Promise<WakeCopyApiResult<{ items?: WakeCandidate[] }>>
  host(): Promise<ClaimerHost | null>
  windowAttached(): boolean
  providerVersion(provider: 'claude' | 'codex'): Promise<string | null>
  /** Chooses again once the copy names the model (the Fable rule); the move runs on that account. */
  chooseAccount(
    provider: 'claude' | 'codex',
    model: string | undefined
  ): Promise<{ providerRoot: string } | { refusal: string }>
  /** The page's decision on the listed revision now: `closed` (rejected, closed, moved on) or null. */
  latestDecision(item: WakeCandidate): Promise<WakeCandidate['decision'] | 'closed' | null>
  /** An account with a fresh capacity reading; never an unverified fallback. */
  providerHome(
    provider: 'claude' | 'codex'
  ): Promise<{ providerRoot: string } | { refusal: string }>
  findWorkspace(required: WakeCopyWorkspace): Promise<ClaimerWorkspace | { refusal: string }>
  claim(
    item: Pick<WakeCandidate, 'slug' | 'revision' | 'decision'>,
    host: ClaimerHost
  ): Promise<WakeCopyApiResult<unknown>>
  /** True once OmniOS no longer holds a claim of this computer's. */
  release(slug: string, host: ClaimerHost, reason: ReleaseReason): Promise<boolean>
  done(slug: string, host: ClaimerHost): Promise<WakeCopyApiResult<unknown>>
  /** Downloads every part, unpacks and checks the header against the listing. */
  fetchCopy(
    item: WakeCandidate,
    host: ClaimerHost
  ): Promise<{ header: WakeCopyHeader; bundleRoot: string; writtenRoot: string }>
  /** Creates the folder workspace or the worktree; returns the path the session runs in. */
  prepareWorkspace(workspace: ClaimerWorkspace): Promise<string>
  restoreWritten(header: WakeCopyHeader, writtenRoot: string, folder: string): Promise<string[]>
  stage(input: {
    header: WakeCopyHeader
    bundleRoot: string
    providerRoot: string
    workspacePath: string
    providerVersion: string
  }): Promise<StagedRelocation>
  /** Throws ClaimerStepError before a terminal starts; any other error means one may run. */
  launch(
    staged: StagedRelocation,
    workspacePath: string,
    header: WakeCopyHeader
  ): Promise<{ paneKey: string }>
  deliver(paneKey: string, item: WakeCandidate, sessionId: string, moved: MoveFacts): Promise<void>
  accountLabel(provider: 'claude' | 'codex', providerRoot: string): string | null
  readClaims(): Record<string, ClaimRecord>
  writeClaim(slug: string, record: ClaimRecord | null): void
  cleanup(slug: string, revision: number): Promise<void>
  audit(item: Pick<WakeCandidate, 'slug' | 'revision'>, summary: string): void
  now(): number
}

export type MoveFacts = { from: string; to: string; folder: string; account: string | null }

const RETRY_MS = 30 * 60_000
const UNRESOLVED = new Set<ClaimRecord['phase']>([
  'claiming',
  'claimed',
  'releasing',
  'launching',
  'moved'
])
const refusedUntil = new Map<string, number>()

/** Why this computer cannot run it, or what it runs with; nothing here changes anything. */
async function runnable(
  deps: WakeClaimerDeps,
  item: WakeCandidate
): Promise<
  | { refusal: string }
  | { workspace: ClaimerWorkspace; providerRoot: string; providerVersion: string }
> {
  const { provider, providerVersion: written } = item.requirements
  const local = await deps.providerVersion(provider)
  if (!local) {
    return { refusal: `${provider} is not installed here` }
  }
  if (written && (compareProviderVersions(written, local) ?? 0) > 0) {
    return { refusal: `${provider} here is older than the one that wrote it` }
  }
  const workspace = await deps.findWorkspace(item.requirements.workspace)
  if ('refusal' in workspace) {
    return workspace
  }
  const home = await deps.providerHome(provider)
  return 'refusal' in home
    ? home
    : { workspace, providerRoot: home.providerRoot, providerVersion: local }
}

/** One wake per pass at most: a move is heavy, and the next pass picks up the next one. */
export async function runWakeClaims(deps: WakeClaimerDeps): Promise<void> {
  const host = await deps.host()
  if (!host) {
    return
  }
  await settleClaims(deps, host)
  if (!deps.windowAttached() || !deps.enabled()) {
    return
  }
  const listed = await deps.candidates()
  if (listed.status !== 'ok') {
    return
  }
  const claims = deps.readClaims()
  const now = deps.now()
  let won = false
  for (const item of listed.value.items ?? []) {
    try {
      if (!validCandidate(item)) {
        continue
      }
      const key = `${item.slug}:${item.revision}:${item.decision.id}`
      const earlier = claims[item.slug]
      const sameDecision =
        earlier?.revision === item.revision && earlier.decisionId === String(item.decision.id)
      if (
        Date.parse(item.claimableAt) > now ||
        (earlier && UNRESOLVED.has(earlier.phase)) ||
        (sameDecision &&
          (earlier.phase !== 'failed' ||
            // Why not again for this decision: the same copy or account answer would repeat.
            earlier.release === 'could not verify' ||
            earlier.final === true ||
            now - earlier.at < RETRY_MS)) ||
        (refusedUntil.get(key) ?? 0) > now
      ) {
        continue
      }
      const check = await runnable(deps, item).catch((error: unknown) => ({
        refusal: String(error)
      }))
      if ('refusal' in check) {
        refusedUntil.set(key, now + RETRY_MS)
        continue
      }
      const record: ClaimRecord = {
        revision: item.revision,
        decisionId: String(item.decision.id),
        phase: 'claiming',
        at: now,
        provider: item.requirements.provider
      }
      deps.writeClaim(item.slug, record)
      const claimed = await deps.claim(item, host)
      if (claimed.status === 'refused') {
        deps.writeClaim(item.slug, { ...record, phase: 'failed', reason: claimed.code })
        continue
      }
      if (claimed.status !== 'ok') {
        // It may have won: the next pass releases it.
        continue
      }
      won = true
      await wakeClaimed(deps, item, host, { ...record, phase: 'claimed' }, check)
      return
    } catch {
      // One bad candidate never blocks the others; a won claim ends the pass either way.
      if (won) {
        return
      }
    }
  }
}

async function wakeClaimed(
  deps: WakeClaimerDeps,
  item: WakeCandidate,
  host: ClaimerHost,
  record: ClaimRecord,
  check: { workspace: ClaimerWorkspace; providerRoot: string; providerVersion: string }
): Promise<void> {
  deps.writeClaim(item.slug, record)
  let launching: ClaimRecord | null = null
  try {
    const copy = await deps.fetchCopy(item, host)
    // Why choose again: rankings move, and the copy's model can change which account fits.
    const account = await deps.chooseAccount(
      item.requirements.provider,
      copy.header.model ?? undefined
    )
    if (!('providerRoot' in account)) {
      throw new ClaimerStepError(account.refusal, 'cannot run here', true)
    }
    const workspacePath = await deps.prepareWorkspace(check.workspace)
    const kept = await deps.restoreWritten(copy.header, copy.writtenRoot, workspacePath)
    const staged = await deps
      .stage({
        header: copy.header,
        bundleRoot: copy.bundleRoot,
        providerRoot: account.providerRoot,
        workspacePath,
        providerVersion: check.providerVersion
      })
      .catch((error: unknown) => {
        throw new ClaimerStepError(
          error instanceof Error ? error.message : String(error),
          'could not verify'
        )
      })
    launching = { ...record, phase: 'launching', at: deps.now(), sessionId: copy.header.sessionId }
    deps.writeClaim(item.slug, launching)
    const launched = await deps.launch(staged, workspacePath, copy.header)
    // Why done before the message: it runs here now, so the owner must give it up either way.
    await confirmDone(deps, item.slug, host, launching)
    // Why read again: the move takes minutes; a decision changed meanwhile is the one that counts.
    const latest = await deps.latestDecision(item).catch(() => null)
    if (latest === null || latest === 'closed') {
      // Why nothing on an unread page: an Approve sent after a Reject would act on a refused plan.
      deps.audit(
        item,
        latest === 'closed'
          ? `Moved page ${item.slug}'s session here, but its decision changed or the page closed meanwhile; nothing was sent to it.`
          : `Moved page ${item.slug}'s session here, but its decision could not be read again; nothing was sent to it. Open the page and the session.`
      )
      return
    }
    const current = { ...item, decision: latest }
    await deps
      .deliver(launched.paneKey, current, copy.header.sessionId, {
        from: item.ownerHost,
        to: host.host,
        folder: workspacePath,
        account: deps.accountLabel(item.requirements.provider, account.providerRoot)
      })
      .catch((error: unknown) =>
        deps.audit(
          item,
          `Moved page ${item.slug}'s session here, but its decision was not queued: ${String(error)}`
        )
      )
    deps.audit(
      item,
      `Woke ${item.requirements.provider} conversation ${copy.header.sessionId} here for the decision on page ${item.slug}: moved from ${item.ownerHost} because it was off${kept.length ? `; kept newer files here: ${kept.join(', ')}` : ''}.`
    )
  } catch (error) {
    const why = (error instanceof Error ? error.message : String(error)).slice(0, 300)
    if (launching && !(error instanceof ClaimerStepError)) {
      // A terminal may run it here: never released, so it cannot run twice; confirmed done.
      await confirmDone(deps, item.slug, host, launching)
      deps.audit(
        item,
        `Page ${item.slug}'s session started here but could not be confirmed: ${why}`
      )
      return
    }
    const step = error instanceof ClaimerStepError ? error : null
    // Why a plain error is retried: a git or network blip before the launch passes.
    await release(
      deps,
      item.slug,
      host,
      step?.final ? { ...record, final: true } : record,
      step?.release ?? 'cannot run here',
      why
    )
    const reason = step?.release ?? 'cannot run here'
    deps.audit(item, `Could not wake page ${item.slug}'s session here (${reason}): ${why}`)
  } finally {
    await deps.cleanup(item.slug, item.revision).catch(() => {})
  }
}
