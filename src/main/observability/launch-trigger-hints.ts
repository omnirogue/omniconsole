import {
  attemptLaunchProvenance,
  warnLaunchProvenanceFailure
} from '../launch-ledger/launch-provenance-guard'
import { randomUUID } from 'node:crypto'
// Main-side launch-cause hints connect renderer spawns to their requesting actor.
//
// Some launches are caused by a request only main sees: a CLI/runtime create that
// the renderer materializes, a phone opening a terminal, a browser-automation lease
// that background-mounts a worktree. Main notes the request here; when the
// renderer's pty:spawn for that tab arrives moments later, the spawn path reads the
// hint to label `launch.trigger` (see shared/launch-trigger.ts for precedence).
//
// A hint only describes a launch; it never admits, delays or skips one.
// Bounded and short-lived, so a stale hint cannot label a much later launch.

import { normalizeLaunchCause, type LaunchCause } from '../../shared/launch-cause'
import type { MainLaunchTriggerHint } from '../../shared/launch-trigger'

export const LAUNCH_TRIGGER_HINT_TTL_MS = 30_000
const MAX_LAUNCH_TRIGGER_HINTS = 256
// Why a sentinel: a CLI create with no worktree selector lands in the renderer's active
// worktree, so main can only name the tab; tab ids are unique, so the tab alone matches.
const ANY_WORKTREE = '\u0000any'
const WHOLE_WORKTREE = '\u0000worktree'

type LaunchTriggerHint = {
  readonly trigger: MainLaunchTriggerHint
  readonly cause: LaunchCause
  readonly hasStartupCommand: boolean
  readonly notedAt: number
}

const hints = new Map<string, LaunchTriggerHint>()

function hintKey(
  worktreeId: string | undefined,
  tabId: string | undefined,
  leafId?: string
): string {
  return `${worktreeId || ANY_WORKTREE}\u0001${tabId || WHOLE_WORKTREE}\u0001${leafId ?? ''}`
}

function readLive(key: string, now: number): LaunchTriggerHint | null {
  const hint = hints.get(key)
  if (!hint) {
    return null
  }
  if (now - hint.notedAt > LAUNCH_TRIGGER_HINT_TTL_MS || now < hint.notedAt) {
    hints.delete(key)
    return null
  }
  return hint
}

/**
 * Record that main asked for a launch-capable mount or create. Never throws. A hint
 * must name a worktree or a tab: one naming neither (a browser lease with no worktree
 * selector) would relabel every spawn in every worktree for the TTL, which is exactly
 * the restore flood after a restart, so it is not recorded.
 */
export function noteLaunchTriggerHint(
  args: {
    worktreeId?: string
    tabId?: string
    leafId?: string
    trigger: MainLaunchTriggerHint
    launchCause?: LaunchCause
    hasStartupCommand?: boolean
  },
  now?: number
): void {
  try {
    now ??= Date.now()
    if (!args.worktreeId && !args.tabId) {
      return
    }
    const key = hintKey(args.worktreeId, args.tabId, args.leafId)
    hints.delete(key)
    hints.set(key, {
      trigger: args.trigger,
      cause: normalizeLaunchCause(args.launchCause ?? { trigger: args.trigger }),
      hasStartupCommand: args.hasStartupCommand ?? true,
      notedAt: now
    })
    while (hints.size > MAX_LAUNCH_TRIGGER_HINTS) {
      const oldest = hints.keys().next()
      if (oldest.done) {
        break
      }
      hints.delete(oldest.value)
    }
  } catch {
    warnLaunchProvenanceFailure('launch-hints')
  }
}

/**
 * Peek during preparation; consume tab hints only after recording an execution receipt.
 * Worktree-wide hints stay until expiry because one lease can mount several tabs.
 */
export function takeLaunchCauseHints(
  args: { worktreeId?: string; tabId?: string; leafId?: string; hasLaunchCommand?: boolean },
  now?: number,
  consume = true
): { tabCause: LaunchCause | null; worktreeCause: LaunchCause | null } {
  try {
    now ??= Date.now()
    let tabCause: LaunchCause | null = null
    if (args.tabId) {
      const keys = args.leafId
        ? [
            hintKey(args.worktreeId, args.tabId, args.leafId),
            hintKey(undefined, args.tabId, args.leafId)
          ]
        : []
      keys.push(hintKey(args.worktreeId, args.tabId), hintKey(undefined, args.tabId))
      for (const key of keys) {
        const hint = readLive(key, now)
        if (hint && hint.hasStartupCommand === (args.hasLaunchCommand ?? true)) {
          if (consume) {
            hints.delete(key)
          }
          tabCause = hint.cause
          break
        }
      }
    }
    const worktreeHint =
      args.worktreeId && (args.hasLaunchCommand ?? true)
        ? readLive(hintKey(args.worktreeId, undefined), now)
        : null
    return { tabCause, worktreeCause: worktreeHint?.cause ?? null }
  } catch {
    warnLaunchProvenanceFailure('launch-hints')
    return { tabCause: null, worktreeCause: null }
  }
}

export function takeLaunchTriggerHints(
  args: { worktreeId?: string; tabId?: string },
  now?: number
): { tabHint: MainLaunchTriggerHint | null; worktreeHint: MainLaunchTriggerHint | null } {
  return attemptLaunchProvenance(
    'launch-hints',
    () => {
      const { tabCause, worktreeCause } = takeLaunchCauseHints(args, now)
      return { tabHint: tabCause?.trigger ?? null, worktreeHint: worktreeCause?.trigger ?? null }
    },
    { tabHint: null, worktreeHint: null }
  )
}

export function _resetLaunchTriggerHintsForTests(): void {
  hints.clear()
}

export function _launchTriggerHintCountForTests(): number {
  return hints.size
}

/** Name the tab before the renderer mounts it, so a fast spawn cannot outrun its cause hint. */
export function reserveRendererLaunchCause(args: {
  worktreeId?: string
  tabId?: string
  launchCause?: LaunchCause
  hasStartupCommand: boolean
}): string {
  return attemptLaunchProvenance(
    'launch-hints',
    () => {
      const tabId = args.tabId ?? randomUUID()
      if (args.launchCause) {
        noteLaunchTriggerHint({
          ...args,
          tabId,
          trigger: args.launchCause.trigger,
          launchCause: { ...args.launchCause, actor: args.launchCause.actor ?? { kind: 'app' } }
        })
      }
      return tabId
    },
    ''
  )
}

/** Move the reserved identity before the renderer's allocated tab can spawn. */
export function transferRendererLaunchCause(args: {
  worktreeId?: string
  requestedTabId: string
  tabId: string
}): void {
  return attemptLaunchProvenance(
    'launch-hints',
    () => {
      if (!args.requestedTabId || args.requestedTabId === args.tabId) {
        return
      }
      const key = hintKey(args.worktreeId, args.requestedTabId)
      const hint = readLive(key, Date.now())
      hints.delete(key)
      if (hint) {
        hints.set(hintKey(args.worktreeId, args.tabId), hint)
      }
    },
    undefined
  )
}
