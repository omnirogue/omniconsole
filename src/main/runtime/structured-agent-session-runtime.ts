import type { openAcpJsonRpcConnection } from '../acp/acp-jsonrpc-connection'
// Where the structured agent-session wire becomes a live host on this runtime.
//
// Built on the first `agentSession.*` call rather than at startup: the record
// store and the journals live under the profile's user-data path, which is not
// final until Electron is ready, and a runtime that never serves a structured
// session should not pay for a store it will never read. The slot the RPC layer
// reads is module-level for the same reason the registry is — the runtime
// service is already far past its size budget.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { CodexStructuredSessionAdapterDeps } from '../codex/codex-structured-session-adapter'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import type { ClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'
import type { StructuredClaudeRuntimeAdapterDeps } from './structured-claude-runtime-adapter'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from '../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { StructuredAgentSessionHandoffTransport } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import { stopOrphanAgentSessionChildren } from './agent-session-orphan-child-reaper'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { recordAgentSessionProviderHandle } from './agent-session-provider-handle-transition'
import { createStructuredAgentSessionAdapters } from './structured-agent-session-runtime-adapters'
import {
  createStructuredAgentSessionOwnerProbe,
  createStructuredAgentSessionOwnerProbes
} from './structured-agent-session-owner-probe'
import {
  pendingRuntimeTeardown,
  tearDownOutstandingRuntimes,
  type InstalledRuntime
} from './structured-agent-session-runtime-teardown'

/** Sibling of the journal tree rather than inside it: one file adjudicates every
 *  session's lease, while a journal is per session. */
const RECORD_STORE_DIR_NAME = 'agent-sessions'

export function hasPersistedStructuredAgentSessionStore(
  stateDirectory: string,
  fileExists: (path: string) => boolean = existsSync
): boolean {
  const filePath = agentSessionStorePath(join(stateDirectory, RECORD_STORE_DIR_NAME))
  return fileExists(filePath) || fileExists(`${filePath}.bak`)
}

export type StructuredAgentSessionRuntimeDeps = {
  /** Host state root. The record store and the journal tree both hang off it. */
  stateDirectory: string
  /** Execution host this runtime *is*. A record pinned elsewhere is not ours to
   *  probe and not ours to spawn for. */
  hostId: string
  /** Key id this host's claims are minted under. */
  claimKeyId: string
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveWorkspaceHubTaskId?: (
    workspaceId: string
  ) => Promise<string | undefined> | string | undefined
  resolveCodexCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  resolveClaudeCommand?: () => string
  resolveClaudeLaunchEnv?: () => Promise<Record<string, string>> | Record<string, string>
  /** Managed-account auth state for a structured Claude launch, mirroring the terminal
   *  preflight. Absent switches the Claude Agent SDK lane off entirely: a launch with no
   *  policy cannot say which account it authenticates as. */
  resolveClaudeAuthPolicy?: () => Promise<ClaudeStructuredAuthPolicy> | ClaudeStructuredAuthPolicy
  /** Whether the Claude Agent SDK lane is live right now — the experimental Structured
   *  Chat setting, read per call so toggling it does not need a runtime restart. Absent
   *  switches the lane off: registering it and enabling it are separate answers. */
  claudeStructuredEnabled?: () => boolean
  readClaudeManagedAccountGate?: () => ClaudeManagedAccountGateSettings | null
  /** Provider transports are overridden only to drive the runtime against scripted children. */
  openCodexConnection?: CodexStructuredSessionAdapterDeps['openConnection']
  openClaudeConnection?: StructuredClaudeRuntimeAdapterDeps['openClaudeConnection']
  openAcpConnection?: typeof openAcpJsonRpcConnection
  acpEnabled?: (agent: string) => boolean
  acpSettings?: () => GlobalSettings
  resolveAcpEnvironment?: () => Promise<NodeJS.ProcessEnv>
  /** Scripted app-servers carry fake pids the real start-time read cannot answer for. */
  readProcessStartTime?: CodexStructuredSessionAdapterDeps['readProcessStartTime']
  resolveLaunchArgs?: (provider: AgentSessionRecord['provider']) => Promise<string[]> | string[]
  resolveLaunchEnv?: () => Promise<NodeJS.ProcessEnv>
  resolveLaunchEnvOverlay?: () => Promise<Record<string, string>> | Record<string, string>
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveCodexOverrides?: () => NodeJS.ProcessEnv
  onError?: (input: { scope: string; error: unknown }) => void
  onJournalCheckpoint?: StructuredAgentSessionHostDeps['onJournalCheckpoint']
  onSessionStarted?: StructuredAgentSessionHostDeps['onSessionStarted']
  onSessionStopped?: StructuredAgentSessionHostDeps['onSessionStopped']
  onJournalReady?: StructuredAgentSessionHostDeps['onJournalReady']
  handoffTransport?: StructuredAgentSessionHandoffTransport
  reapOrphanChildren?: typeof stopOrphanAgentSessionChildren
}

let installing: Promise<InstalledRuntime> | null = null
let stopping: Promise<void> | null = null
let shutdownRequested = false

export function ensureStructuredAgentSessionHost(
  deps: StructuredAgentSessionRuntimeDeps
): Promise<StructuredAgentSessionHost> {
  if (shutdownRequested) {
    return Promise.reject(new Error('Native runtime shutdown needs to finish before reopening.'))
  }
  // A failed open must not poison the slot forever — the next call retries.
  installing ??= install(deps).catch((error) => {
    installing = null
    throw error
  })
  return installing.then((installed) => installed.host)
}

/** Resolves once every provider exit observed so far has been published by its
 *  adapter and reconciled by the host. Nothing is installed, nothing to wait on.
 *
 *  This is the only handle onto that barrier: reconciliation is driven by exit
 *  callbacks, so a caller that needs the settled lease — rather than the one the
 *  exit is still being reconciled out of — has no other way to know it landed. */
export async function waitForStructuredAgentSessionRecovery(): Promise<void> {
  const installed = await installing?.catch(() => null)
  await installed?.waitForRecovery()
}

/** Drops the host and reaps every Codex child under it. Runtime teardown and
 *  test isolation take the same path, so neither can leave a live app-server.
 *
 *  A teardown that fails is RETRIED by the next stop rather than forgotten: the
 *  host keeps every journal whose close rejected, and this is the only handle
 *  onto that host once the module slot is cleared.
 *
 *  OmniConsole: stop is single-flight — a second caller joins the first rather
 *  than racing it, and `shutdownRequested` blocks a reopen until it settles. */
export function stopStructuredAgentSessionRuntime(): Promise<void> {
  if (stopping) {
    return stopping
  }
  const pending = installing
  shutdownRequested = true
  setStructuredAgentSessionHost(null)
  agentSessionPtyWriteGate.detachRecordLookup()
  let completed = false
  const outstanding = new Set(pendingRuntimeTeardown)
  pendingRuntimeTeardown.clear()
  stopping = (async () => {
    const installed = await pending?.catch(() => null)
    if (installed) {
      outstanding.add(installed)
    }
    const failures = await tearDownOutstandingRuntimes(outstanding)
    completed = failures.length === 0
    if (failures.length === 1) {
      throw failures[0]
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'structured agent-session runtime teardown failed')
    }
  })().finally(() => {
    setStructuredAgentSessionHost(null)
    agentSessionPtyWriteGate.detachRecordLookup()
    stopping = null
    if (completed) {
      installing = null
      shutdownRequested = false
    }
  })
  return stopping
}

async function install(deps: StructuredAgentSessionRuntimeDeps): Promise<InstalledRuntime> {
  const bootEnvironment = (deps.resolveEnvironment ?? resolveLoginShellEnvironment)()
  const resolveEnvironment = async (): Promise<NodeJS.ProcessEnv> => ({
    ...(await bootEnvironment),
    ...(await deps.resolveLaunchEnv?.()),
    ...(await deps.resolveLaunchEnvOverlay?.()),
    ...deps.resolveCodexOverrides?.()
  })
  const store = await AgentSessionRecordStore.open({
    directory: join(deps.stateDirectory, RECORD_STORE_DIR_NAME),
    hostId: deps.hostId
  })
  agentSessionPtyWriteGate.attachRecordLookup((sessionId) => store.getRecord(sessionId))
  // Why: only the durable store can identify a provider child lost before record publication.
  void (deps.reapOrphanChildren ?? stopOrphanAgentSessionChildren)({ store }).catch((error) => {
    try {
      if (deps.onError) {
        deps.onError({ scope: 'agent-session-orphan-child-reaper', error })
      } else {
        console.error('[structured-agent-session] orphan reaper failed', error)
      }
    } catch (reportingError) {
      console.error(
        '[structured-agent-session] orphan reaper error reporting failed',
        reportingError
      )
    }
  })
  try {
    let host: StructuredAgentSessionHost | null = null
    let recoveryChain = Promise.resolve()
    const adapter = createStructuredAgentSessionAdapters({
      deps,
      store,
      bootEnvironment,
      resolveEnvironment,
      onUnexpectedExit: (event) => {
        // Serialize recovery with teardown. Exit callbacks arrive from child
        // process tasks, so a fire-and-forget callback can otherwise append
        // after the host has flushed and its journal directory is removed.
        recoveryChain = recoveryChain.then(async () => {
          try {
            await host?.handleAdapterEvent(event)
          } catch (error) {
            deps.onError?.({ scope: `structured-agent-session-exit:${event.sessionId}`, error })
          }
        })
      },
      onBackgroundTasksChanged: (sessionId, state) =>
        host?.publishBackgroundTaskState(sessionId, state)
    })
    // Assigned, not declared: the Codex exit callback above closes over `host`.
    host = new StructuredAgentSessionHost({
      store,
      adapter,
      journalRoot: deps.stateDirectory,
      claimKeyId: deps.claimKeyId,
      ...(deps.resolveWorkspaceHubTaskId
        ? { resolveWorkspaceHubTaskId: deps.resolveWorkspaceHubTaskId }
        : {}),
      probeOwner: createStructuredAgentSessionOwnerProbe(deps.hostId),
      probeOwners: createStructuredAgentSessionOwnerProbes(deps.hostId),
      ...(deps.resolveLaunchArgs
        ? {
            resolveLaunchArgs: async (provider: AgentSessionRecord['provider']) =>
              await deps.resolveLaunchArgs!(provider)
          }
        : {}),
      onEventSinkError: ({ sessionId, error }) =>
        deps.onError?.({ scope: `structured-agent-session-journal:${sessionId}`, error }),
      ...(deps.onJournalCheckpoint ? { onJournalCheckpoint: deps.onJournalCheckpoint } : {}),
      ...(deps.onSessionStopped ? { onSessionStopped: deps.onSessionStopped } : {}),
      ...(deps.onSessionStarted ? { onSessionStarted: deps.onSessionStarted } : {}),
      ...(deps.onJournalReady ? { onJournalReady: deps.onJournalReady } : {}),
      persistTuiProviderHandle: async ({ sessionId, link, now }) => {
        await store.transitionHandoff(sessionId, (record) =>
          recordAgentSessionProviderHandle({ record, fence: record.lease.runtimeFence, link, now })
        )
      },
      ...(deps.handoffTransport ? { handoffTransport: deps.handoffTransport } : {})
    })
    if (!shutdownRequested) {
      setStructuredAgentSessionHost(host)
    }
    return {
      host,
      adapter,
      waitForRecovery: async () => {
        // A recovery may synchronously trigger another exit while it is
        // reacquiring. Observe until the chain stops growing.
        for (;;) {
          // Claude reaches the chain only once its close ladder and transcript
          // write publish the exit, so an observed death is not yet a chained
          // one. Codex publishes inside its own exit callback and needs nothing.
          await adapter.drainObservedExits()
          const observed = recoveryChain
          await observed
          if (observed === recoveryChain) {
            return
          }
        }
      }
    }
  } catch (error) {
    agentSessionPtyWriteGate.detachRecordLookup()
    throw error
  }
}

// Re-exported at the module that installs the runtime: both probes were defined
// here before the split, and the wire and its tests import them from this path.
export {
  createStructuredAgentSessionOwnerProbe,
  createStructuredAgentSessionOwnerProbes
} from './structured-agent-session-owner-probe'
