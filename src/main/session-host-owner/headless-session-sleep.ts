import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  automaticSessionCleanupKeep,
  normalizeAutomaticSessionCleanupProtection
} from '../../shared/automatic-session-cleanup-protection'
import {
  getEffectiveIdleAutoCloseMs,
  resolveIdleAutoCloseGate
} from '../../shared/idle-auto-close-settings'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { TerminalAgentProcessProof } from '../runtime/terminal-agent-process'
import type { ReviewSleepTarget } from '../../shared/artifact-review-sleep'
import { withAgentLaunchOptions } from '../../shared/agent-command-launch-options'

export type HeadlessSleepSettings = Partial<
  Pick<
    GlobalSettings,
    | 'idleAutoCloseMode'
    | 'idleAutoCloseMinutes'
    | 'restoreFloodGuard'
    | 'experimentalAgentHibernation'
    | 'agentHibernationIdleMs'
    | 'automaticSessionCleanupProtection'
    | 'reviewWaitLiveMinutes'
  >
>

export type HeadlessSleepSnapshot = {
  row: SessionManageSidebarRow
  ptyId: string
  incarnationId: string
  terminalHandle: string
  leafId: string
  createdAt: number
  lastActivityAt: number
  routine: boolean | null
  record: SleepingAgentSessionRecord
}

export type HeadlessSleepDeps = {
  enabled(): boolean
  settings(): HeadlessSleepSettings
  authority(row: SessionManageSidebarRow): string | null
  read(row: SessionManageSidebarRow): Promise<HeadlessSleepSnapshot | null>
  clear(
    row: SessionManageSidebarRow,
    options?: { reviewWait?: boolean }
  ): Promise<TerminalAgentProcessProof | null>
  /** Panes waiting on a review decision, read once per pass (artifact-review-sleep-targets.ts). */
  reviewTargets?(): ReadonlyMap<string, ReviewSleepTarget>
  /** A pane waiting on its review was slept. */
  reviewSlept?(row: SessionManageSidebarRow): void
  sleep(
    snapshot: HeadlessSleepSnapshot,
    guard: () => Promise<boolean>,
    proof: TerminalAgentProcessProof
  ): Promise<boolean>
  audit(snapshot: HeadlessSleepSnapshot, outcome: 'would' | 'done' | 'failed'): Promise<void>
  now(): number
}

function policy(settings: HeadlessSleepSettings) {
  const gate = resolveIdleAutoCloseGate(settings)
  const idleMs = Math.max(
    getEffectiveIdleAutoCloseMs(settings.idleAutoCloseMinutes),
    settings.experimentalAgentHibernation === true &&
      Number.isFinite(settings.agentHibernationIdleMs)
      ? (settings.agentHibernationIdleMs ?? 0)
      : 0
  )
  return {
    gate,
    idleMs,
    fingerprint: JSON.stringify([gate, idleMs, settings.automaticSessionCleanupProtection])
  }
}

function identity(snapshot: HeadlessSleepSnapshot): string {
  return JSON.stringify([
    snapshot.row.worktreeId,
    snapshot.row.paneKey,
    snapshot.ptyId,
    snapshot.incarnationId,
    snapshot.record.agent,
    snapshot.record.providerSession,
    snapshot.record.launchConfig,
    snapshot.lastActivityAt
  ])
}

function allowed(
  snapshot: HeadlessSleepSnapshot,
  settings: HeadlessSleepSettings,
  now: number,
  reviewWait = false
): boolean {
  const config = normalizeAutomaticSessionCleanupProtection(
    settings.automaticSessionCleanupProtection
  )
  return (
    automaticSessionCleanupKeep({
      // Why: the session's own review publish lifts only the started-today hold.
      config: config && reviewWait ? { ...config, protectStartedToday: false } : config,
      target: {
        worktreePath: snapshot.row.worktreePath,
        paneKey: snapshot.row.paneKey,
        createdAt: snapshot.createdAt
      },
      facts: { routine: snapshot.routine, pinned: snapshot.row.pinned, saved: snapshot.row.saved },
      now
    }) === null
  )
}

/** Runs inside the existing owner pass; remembered metadata never establishes process liveness. */
export function createHeadlessSessionSleep(deps: HeadlessSleepDeps) {
  const observed = new Map<string, { identity: string; since: number; logged: boolean }>()
  return async (rows: readonly SessionManageSidebarRow[]): Promise<void> => {
    const initial = policy(deps.settings())
    if (!deps.enabled() || initial.gate.mode === 'off') {
      observed.clear()
      return
    }
    const reviews = deps.reviewTargets?.() ?? new Map<string, ReviewSleepTarget>()
    const reviewOf = (row: SessionManageSidebarRow): ReviewSleepTarget | undefined => {
      const target = row.paneKey ? reviews.get(row.paneKey) : undefined
      return target?.worktreeId === row.worktreeId ? target : undefined
    }
    // Why the record carries the review's model/effort: the decision's wake resumes exactly.
    const read = async (row: SessionManageSidebarRow): Promise<HeadlessSleepSnapshot | null> => {
      const snapshot = await deps.read(row)
      const options = reviewOf(row)?.launchOptions
      const agent = snapshot?.record.agent
      if (!snapshot || !options || (agent !== 'claude' && agent !== 'codex')) {
        return snapshot
      }
      const launchConfig = withAgentLaunchOptions(snapshot.record.launchConfig, agent, options)
      return { ...snapshot, record: { ...snapshot.record, launchConfig } }
    }
    const present = new Set(rows.map((row) => row.rowKey))
    for (const key of observed.keys()) {
      if (!present.has(key)) {
        observed.delete(key)
      }
    }
    for (const row of rows) {
      if (!deps.enabled() || policy(deps.settings()).fingerprint !== initial.fingerprint) {
        observed.clear()
        return
      }
      const review = reviewOf(row)
      const reviewWait = review !== undefined
      const snapshot = await read(row)
      const now = deps.now()
      const authority = deps.authority(row)
      const proof =
        authority && snapshot && allowed(snapshot, deps.settings(), now, reviewWait)
          ? await deps.clear(row, { reviewWait })
          : null
      if (
        !snapshot ||
        !proof ||
        !authority ||
        proof.ptyId !== snapshot.ptyId ||
        proof.incarnationId !== snapshot.incarnationId
      ) {
        observed.delete(row.rowKey)
        continue
      }
      const key = identity(snapshot)
      let clock = observed.get(row.rowKey)
      if (!clock || clock.identity !== key) {
        clock = { identity: key, since: now, logged: false }
        observed.set(row.rowKey, clock)
      }
      if (
        now - Math.max(clock.since, snapshot.lastActivityAt) <
        (review?.idleMs ?? initial.idleMs)
      ) {
        continue
      }
      if (!initial.gate.act) {
        if (!clock.logged) {
          await deps.audit(snapshot, 'would')
          clock.logged = true
        }
        continue
      }
      const guard = async (): Promise<boolean> => {
        if (!deps.enabled() || policy(deps.settings()).fingerprint !== initial.fingerprint) {
          return false
        }
        const current = await read(row)
        if (
          !current ||
          identity(current) !== key ||
          !allowed(current, deps.settings(), deps.now(), reviewWait)
        ) {
          return false
        }
        const currentProof = await deps.clear(row, { reviewWait })
        const last = await read(row)
        return (
          last !== null &&
          identity(last) === key &&
          allowed(last, deps.settings(), deps.now(), reviewWait) &&
          deps.authority(row) === authority &&
          deps.enabled() &&
          policy(deps.settings()).fingerprint === initial.fingerprint &&
          currentProof !== null &&
          currentProof.ptyId === proof.ptyId &&
          currentProof.incarnationId === proof.incarnationId &&
          currentProof.pid === proof.pid &&
          currentProof.rootPid === proof.rootPid &&
          currentProof.pgid === proof.pgid &&
          currentProof.startTimeMs === proof.startTimeMs
        )
      }
      try {
        if (await guard()) {
          const exited = await deps.sleep(snapshot, guard, proof)
          await deps.audit(snapshot, exited ? 'done' : 'failed')
          if (exited && reviewWait) {
            deps.reviewSlept?.(row)
          }
        }
      } catch {
        await deps.audit(snapshot, 'failed')
      }
      observed.delete(row.rowKey)
    }
  }
}
