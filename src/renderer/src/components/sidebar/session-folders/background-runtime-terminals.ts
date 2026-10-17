/**
 * Runtime-owned terminals on this computer that no window tab shows — "running in the background,
 * not in a window" (plan step 5). The Conversations sidebar lists them with Open (adopt visibly,
 * the `omni session show` path) and End (the `omni terminal close` path); nothing ends one
 * automatically, and an unknown answer never hides one already listed.
 */
import { create } from 'zustand'
import type { BackgroundRuntimeTerminal } from '../../../../../shared/background-runtime-terminal'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../shared/execution-host'
import {
  HOME_SESSION_HOST_FILTER,
  inSessionHostFilter,
  type SessionHostFilter
} from '@/lib/session-host-scope'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

const BACKGROUND_TERMINALS_POLL_MS = 15_000

type BackgroundTerminalsState = {
  terminals: readonly BackgroundRuntimeTerminal[]
  /** The Conversations host filter in force, so the group shows what the host switch shows. */
  hostFilter: SessionHostFilter
  /** Panes the sidebar already lists as rows; those are not listed (or counted) twice. */
  sidebarPaneKeys: ReadonlySet<string>
}

const NO_PANES: ReadonlySet<string> = new Set()

export const useBackgroundRuntimeTerminals = create<BackgroundTerminalsState>(() => ({
  terminals: [],
  hostFilter: HOME_SESSION_HOST_FILTER,
  sidebarPaneKeys: NO_PANES
}))

/** As `session list` does: a background terminal a sidebar row already shows is that row. */
export function backgroundTerminalsOutsideSidebar(
  terminals: readonly BackgroundRuntimeTerminal[],
  sidebarPaneKeys: ReadonlySet<string>
): BackgroundRuntimeTerminal[] {
  return terminals.filter((terminal) => !terminal.paneKey || !sidebarPaneKeys.has(terminal.paneKey))
}

export async function refreshBackgroundRuntimeTerminals(): Promise<void> {
  const list =
    typeof window === 'undefined' ? undefined : window.api?.runtime?.listBackgroundTerminals
  if (!list) {
    return
  }
  try {
    const terminals = await list()
    // Why keep on null: "cannot tell yet" (a reloading window) never hides a real process.
    if (terminals) {
      useBackgroundRuntimeTerminals.setState({ terminals })
    }
  } catch {
    // Kept as last known for the same reason; the next poll tries again.
  }
}

let watchers = 0
let timer: ReturnType<typeof setInterval> | null = null

/** One shared poll while any sidebar shows the group; returns its release. */
export function watchBackgroundRuntimeTerminals(): () => void {
  watchers += 1
  if (watchers === 1) {
    void refreshBackgroundRuntimeTerminals()
    timer = setInterval(
      () => void refreshBackgroundRuntimeTerminals(),
      BACKGROUND_TERMINALS_POLL_MS
    )
  }
  return () => {
    watchers -= 1
    if (watchers === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

function hostOf(terminal: BackgroundRuntimeTerminal): ExecutionHostId | null {
  return parseExecutionHostId(terminal.hostId)?.id ?? null
}

export function backgroundTerminalsInHostFilter(
  terminals: readonly BackgroundRuntimeTerminal[],
  filter: SessionHostFilter
): BackgroundRuntimeTerminal[] {
  return terminals.filter((terminal) => inSessionHostFilter(hostOf(terminal), filter))
}

/** The host switch's per-host counts with each background terminal counted under its own host. */
export function withBackgroundTerminalCounts(
  counts: ReadonlyMap<ExecutionHostId, number>,
  terminals: readonly BackgroundRuntimeTerminal[]
): Map<ExecutionHostId, number> {
  const next = new Map(counts)
  for (const terminal of terminals) {
    const host = hostOf(terminal) ?? 'local'
    next.set(host, (next.get(host) ?? 0) + 1)
  }
  return next
}

/** Opens it visibly in this window: the window adopts the PTY as a tab (`omni session show`). */
export async function openBackgroundTerminal(handle: string): Promise<void> {
  try {
    await callRuntimeRpc({ kind: 'local' }, 'terminal.focus', {
      terminal: handle,
      navigation: 'host'
    })
  } finally {
    await refreshBackgroundRuntimeTerminals()
  }
}

/**
 * Ends it: main re-checks it (still runtime-owned, in no window, the same PTY), closes it through
 * the audited path `omni terminal close` uses and records who ended it. The caller confirms first.
 */
export async function endBackgroundTerminal(ptyId: string): Promise<void> {
  const end = typeof window === 'undefined' ? undefined : window.api?.runtime?.endBackgroundTerminal
  if (!end) {
    throw new Error('Ending a background terminal requires the desktop host.')
  }
  try {
    await end({ ptyId })
  } finally {
    await refreshBackgroundRuntimeTerminals()
  }
}

/** Whether it is still listed after a fresh read, so a confirmation never asks about a ghost. */
export async function isBackgroundTerminalStillRunning(ptyId: string): Promise<boolean> {
  await refreshBackgroundRuntimeTerminals()
  return useBackgroundRuntimeTerminals
    .getState()
    .terminals.some((terminal) => terminal.ptyId === ptyId)
}
