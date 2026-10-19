/**
 * Whether `omni artifacts share|publish|update` may tie a page to the pane its environment names.
 * Apps started once from a pane (Antigravity, background runners) inherit ORCA_TERMINAL_HANDLE and
 * ORCA_PANE_KEY, so the environment alone stamped one old session on unrelated pages. A page is
 * published unbound, as from outside OmniConsole, when a Claude session the caller reports is not
 * the pane's, when the pane is closed or its tree holds no agent at all, or when the process table
 * shows the caller is not under the pane's agent. Where the tree cannot be read (SSH panes,
 * Windows, a failed `ps`) or an agent is there but unprovable (stopped, not the foreground),
 * today's binding stands. The pane's conversation at verification is pinned: a conversation that
 * replaces it before the page is published never inherits it.
 *
 * The caller's pid is self-reported over the authenticated local socket: this is a guardrail
 * against inherited environments, not a boundary against a hostile local process. Agents run
 * under a daemon (`claude --bg`, tmux) are not under the pane's agent, so they publish unbound.
 */

import type { ArtifactWriteRequest } from '../../shared/artifacts'
import type {
  ArtifactSessionBindingNotice,
  ArtifactWriteOrigin
} from '../../shared/artifact-session'
import {
  getFreshProcessTableSnapshot,
  type ProcessTableRow
} from '../../shared/process-table-snapshot'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { agentHookServer } from '../agent-hooks/server'
import { ledgerIdentityForPane } from '../session-ledger/ledger-lookup'
import { callerAncestry, paneTreeHasAgent } from './artifact-caller-ancestry'
import {
  type ArtifactTerminalIdentitySource,
  artifactSessionSwitched,
  withResolvedArtifactOrigin
} from './artifact-session-origin'

export type ArtifactOriginCallerRuntime = ArtifactTerminalIdentitySource &
  Pick<
    OrcaRuntimeService,
    | 'getTerminalHandleForPaneKey'
    | 'resolveTerminalContext'
    | 'readTerminalProcessEvidence'
    | 'assertTerminalAgentProcess'
    | 'getReportedProviderSessionsForPane'
    | 'getPtyIdForPaneKey'
    | 'localPtyRootProcessIds'
    | 'getLastAgentHookRowForPane'
  >

export type ArtifactOriginCallerDeps = {
  platform: NodeJS.Platform
  readProcessRows: () => Promise<readonly ProcessTableRow[]>
  selfExecutable: string
  /** The live process the pane's hooks name, aliases resolved: the process evidence's reporter. */
  hookPidForPane: (paneKey: string) => number | undefined
}

const DEFAULT_DEPS: ArtifactOriginCallerDeps = {
  platform: process.platform,
  readProcessRows: getFreshProcessTableSnapshot,
  selfExecutable: process.execPath,
  hookPidForPane: (paneKey) => agentHookServer.getLocalAgentPidForPane(paneKey)
}

const NO_AGENT = 'no agent is running in its terminal'
const SWITCHED = 'its terminal switched to another conversation before the page was published'

function lookup<T>(read: () => T | null | undefined): T | null {
  try {
    return read() ?? null
  } catch {
    return null
  }
}

/**
 * The pane's tree was read and holds no agent at all: a dev server or editor left in front. A
 * live hook reporter in the tree counts as an agent, as it does for the process evidence. With no
 * live reporter, only a pane whose agent reported a local process since this app started (and has
 * since exited) is agent-less; after a restart, absence cannot be told from an unrecognised agent.
 */
async function paneRunsNoAgent(
  runtime: ArtifactOriginCallerRuntime,
  paneKey: string,
  deps: ArtifactOriginCallerDeps
): Promise<boolean> {
  const ptyId = lookup(() => runtime.getPtyIdForPaneKey(paneKey))
  const roots = ptyId ? await runtime.localPtyRootProcessIds([ptyId]).catch(() => null) : null
  const rootPid = ptyId ? roots?.get(ptyId) : undefined
  const rows = rootPid ? await deps.readProcessRows().catch(() => null) : null
  if (!rootPid || !rows?.some((row) => row.pid === rootPid)) {
    return false
  }
  const reporter = lookup(() => deps.hookPidForPane(paneKey))
  const reported = lookup(() => runtime.getLastAgentHookRowForPane(paneKey)?.agentPid)
  if (reporter === null && reported === null) {
    return false
  }
  return !paneTreeHasAgent(rows, rootPid, [reporter, reported])
}

/** Null when the caller may bind to the pane; otherwise why the page is published unbound. */
export async function artifactOriginCallerRefusal(
  runtime: ArtifactOriginCallerRuntime,
  origin: ArtifactWriteOrigin,
  paneKey: string,
  callerPid: number | undefined,
  deps: ArtifactOriginCallerDeps = DEFAULT_DEPS
): Promise<string | null> {
  const paneSession = lookup(() => runtime.getReportedProviderSessionsForPane(paneKey)[0]?.id)
  if (origin.claudeSessionId && paneSession && paneSession !== origin.claudeSessionId) {
    return 'this command ran in another Claude conversation than its terminal’s'
  }
  if (deps.platform === 'win32') {
    return null
  }
  const handle = lookup(() => runtime.getTerminalHandleForPaneKey(paneKey))
  if (!handle) {
    return 'the terminal its environment names is not open in OmniConsole'
  }
  if (lookup(() => runtime.resolveTerminalContext(handle))?.connectionId) {
    return null
  }
  const evidence = await runtime.readTerminalProcessEvidence(handle).catch(() => null)
  if (!evidence) {
    return null
  }
  if (!evidence.proof) {
    // Why: an agent that is there but unprovable (stopped, not in front) keeps today's binding.
    const none =
      evidence.tree.kind === 'agent-gone' || (await paneRunsNoAgent(runtime, paneKey, deps))
    return none ? NO_AGENT : null
  }
  if (!callerPid) {
    return null
  }
  const rows = await deps.readProcessRows().catch(() => null)
  if (
    !rows ||
    callerAncestry(rows, callerPid, evidence.proof, deps.selfExecutable) !== 'not-under'
  ) {
    return null
  }
  // Why re-proved: the agent's pid might belong to another process by the time `ps` ran.
  const sameAgent = await runtime
    .assertTerminalAgentProcess(evidence.proof, evidence.proof.ptyId)
    .then(() => true)
    .catch(() => false)
  return sameAgent ? 'this command was not started by the agent in its terminal' : null
}

/** The request the artifact service sees: bound to the caller's pane only when it proves it. */
export async function withVerifiedArtifactOrigin<T extends ArtifactWriteRequest>(
  runtime: ArtifactOriginCallerRuntime,
  request: T,
  callerPid: number | undefined,
  deps?: ArtifactOriginCallerDeps
): Promise<T & Pick<ArtifactWriteRequest, 'unboundReason'>> {
  const resolved = withResolvedArtifactOrigin(runtime, request)
  const paneKey = resolved.origin?.paneKey
  if (!request.origin || !paneKey) {
    return resolved
  }
  const refusal = await artifactOriginCallerRefusal(
    runtime,
    request.origin,
    paneKey,
    callerPid,
    deps
  )
  if (!refusal) {
    return { ...resolved, verifiedSession: ledgerIdentityForPane(paneKey) }
  }
  console.info(`[artifacts] ${request.fileName} published unbound: ${refusal}.`)
  const { origin: _, ...external } = resolved
  return { ...(external as T), unboundReason: refusal }
}

/** Tells the caller its page is not tied to its session; older CLIs ignore the extra field. */
export function withSessionBindingNotice<T extends { status: string; value?: object }>(
  request: Pick<ArtifactWriteRequest, 'unboundReason' | 'origin' | 'verifiedSession'>,
  operation: T
): T {
  const reason = request.unboundReason ?? (artifactSessionSwitched(request) ? SWITCHED : null)
  if (!reason || operation.status !== 'ok' || !operation.value) {
    return operation
  }
  const sessionBinding: ArtifactSessionBindingNotice = { state: 'unbound', reason }
  return { ...operation, value: { ...operation.value, sessionBinding } }
}
