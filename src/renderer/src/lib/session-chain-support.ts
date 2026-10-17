import type { TerminalWaitDependencies } from '@/lib/next-session-launch'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import {
  collectLeafIdsInOrder,
  resolveRootlessTerminalLayoutLeafId
} from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { getActiveRuntimeTarget, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import type { SessionActionPresetId } from '../../../shared/session-action-presets'
import {
  sessionChainPredecessors,
  type SessionChain,
  type SessionChainBlock,
  type SessionChainState
} from '../../../shared/session-chain-types'
import type { SessionChainDestination } from '../../../shared/session-chain-destination'
import type { sessionOutcomeProgress } from '../../../shared/session-outcome-state'
import type { TuiAgent } from '../../../shared/tui-agent'

/** One successor as drafted in the queue dialog. */
export type SessionChainStepDraft = {
  agent: TuiAgent
  prompt: string
  presetId?: SessionActionPresetId
  model?: string
  effort?: string
  accountChoiceId?: string | null
}

/** What the sidebar shows for a row that has a live chain queued after it. */
export type SessionChainRowInfo = {
  summary?: string
  chainId: string
  executionOwnerKey?: string
  outcomeProgress?: ReturnType<typeof sessionOutcomeProgress>
  rowKey: string
  /** Steps still to launch. */
  queued: number
  total: number
  state: SessionChainState
  auto: boolean
  error: string | null
  /** Where the work goes once the plan is through: ended, a person, or back to me. */
  destination: SessionChainDestination
  /** The pane that is asking the person while the plan waits, when one is. */
  blocked: SessionChainBlock | null
  /** Panes the plan's agent steps launched; they carry the plan's lock too. */
  launchedPaneKeys: readonly string[]
}

/** Chains belong to this Mac's profile, so they always live on the local runtime. */
export const LOCAL_CHAIN_TARGET: RuntimeClientTarget = { kind: 'local' }

const PANE_KEY_TIMEOUT_MS = 30_000
const RESOLVE_RETRY_MS = 3_000
const RESOLVE_RETRY_COUNT = 20
const WORKSPACE_READY_TIMEOUT_MS = 30_000

/** The runtime that owns the workspace's terminals (local or a paired runtime host). */
export function workspaceRuntimeTarget(worktreeId: string): RuntimeClientTarget {
  return getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(useAppStore.getState(), worktreeId)
  )
}

export function randomChainId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function chainAbortError(): DOMException {
  return new DOMException('The queued session was cancelled.', 'AbortError')
}

export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

/** Resolve after the workspace session and terminal restoration are ready (or after a bounded wait). */
export function waitForWorkspaceReady(): Promise<boolean> {
  const isReady = () => {
    const state = useAppStore.getState()
    return state.workspaceSessionReady && state.terminalStartupRestorationReady
  }
  if (isReady()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null
    const settle = (ready: boolean) => {
      clearTimeout(timeout)
      unsubscribe?.()
      resolve(ready)
    }
    const timeout = setTimeout(() => settle(isReady()), WORKSPACE_READY_TIMEOUT_MS)
    unsubscribe = useAppStore.subscribe(() => {
      if (isReady()) {
        settle(true)
      }
    })
  })
}

function paneKeyForTab(tabId: string): string | null {
  const layout = useAppStore.getState().terminalLayoutsByTabId[tabId]
  if (!layout) {
    return null
  }
  const leaf =
    collectLeafIdsInOrder(layout.root).find(isTerminalLeafId) ??
    resolveRootlessTerminalLayoutLeafId(layout)
  return leaf ? makePaneKey(tabId, leaf) : null
}

/** The pane key of a tab that was just created; its layout appears once the pane mounts. */
export function waitForTabPaneKey(tabId: string, signal: AbortSignal): Promise<string> {
  const immediate = paneKeyForTab(tabId)
  if (immediate) {
    return Promise.resolve(immediate)
  }
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null
    const finish = (value: string | null) => {
      clearTimeout(timeout)
      unsubscribe?.()
      signal.removeEventListener('abort', onAbort)
      if (value) {
        resolve(value)
      } else {
        reject(new Error('The launched session did not open a terminal pane.'))
      }
    }
    const onAbort = () => finish(null)
    const timeout = setTimeout(() => finish(paneKeyForTab(tabId)), PANE_KEY_TIMEOUT_MS)
    signal.addEventListener('abort', onAbort)
    unsubscribe = useAppStore.subscribe(() => {
      const key = paneKeyForTab(tabId)
      if (key) {
        finish(key)
      }
    })
  })
}

/**
 * Resolve once the launched pane's agent has reported `working` (or after `timeoutMs`).
 * Why: right after the prompt lands the agent is still idle from the host's point of
 * view; waiting for idle at that moment would start the next step immediately.
 */
export function waitForPaneAgentWorking(
  paneKey: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<boolean> {
  const isWorking = () => useAppStore.getState().agentStatusByPaneKey[paneKey]?.state === 'working'
  if (isWorking()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null
    const finish = (value: boolean) => {
      clearTimeout(timeout)
      unsubscribe?.()
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish(false)
    const timeout = setTimeout(() => finish(isWorking()), timeoutMs)
    signal.addEventListener('abort', onAbort)
    unsubscribe = useAppStore.subscribe(() => {
      if (isWorking()) {
        finish(true)
      }
    })
  })
}

/** A just-launched pane may not have its PTY yet; retry resolving it for a while. */
export function withResolveRetry(
  deps: TerminalWaitDependencies,
  signal: AbortSignal
): TerminalWaitDependencies {
  return {
    ...deps,
    resolveSource: async () => {
      let lastError: unknown
      for (let attempt = 0; attempt < RESOLVE_RETRY_COUNT; attempt += 1) {
        if (signal.aborted) {
          throw chainAbortError()
        }
        try {
          return await deps.resolveSource()
        } catch (error) {
          lastError = error
          await sleepUnlessAborted(RESOLVE_RETRY_MS, signal)
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error('The session pane could not be found.')
    }
  }
}

/**
 * The panes a step waits on: the source session for the first step, the pane the
 * nearest earlier agent step launched, or every pane of the fan-out group just before
 * it. Members of one group share the same predecessors.
 */
export function sourcePaneKeysForStep(chain: SessionChain, index: number): string[] {
  const predecessors = sessionChainPredecessors(chain, index)
  if (predecessors.length === 0) {
    return [chain.sourcePaneKey]
  }
  return predecessors
    .map((step) => step.launchedPaneKey ?? null)
    .filter((paneKey): paneKey is string => paneKey !== null)
}

/** The first pane a step waits on; null when a predecessor never launched. */
export function sourcePaneKeyForStep(chain: SessionChain, index: number): string | null {
  return sourcePaneKeysForStep(chain, index)[0] ?? null
}
