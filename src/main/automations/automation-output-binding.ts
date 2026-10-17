import { createHash } from 'node:crypto'
import type {
  Automation,
  AutomationDispatchRequest,
  AutomationOutputBindingRequest,
  AutomationRun
} from '../../shared/automations-types'
import type { Store } from '../persistence'
import type { OrchestrationCompatibilityTerminalAuthority } from '../runtime/omni-runtime'
import type { AutomationWorkspaceProvenanceRequest } from '../../shared/worktree/types'
import {
  bindAutomationLaunchWorkspace,
  createAutomationLaunchProvenanceGrant,
  isAutomationDispatchTokenCurrent,
  isAutomationRunDispatching,
  beginAutomationDispatchTokenUse,
  createAutomationDispatchToken,
  finishAutomationDispatchTokenUse
} from './dispatch-tokens'

const MAX_BINDINGS = 512
const DISPATCH_TTL_MS = 30 * 60_000
const BOUND_TTL_MS = 24 * 60 * 60_000

export type AutomationOutputBinding = Readonly<{
  automationId: string
  runId: string
  agent: string
  workspaceId: string
  paneKey: string
  terminalHandle: string
  ptyId: string
  processIncarnation: string
  launchTokenHash: string
  startedAt: number
}>

type BindingGrant = {
  request: AutomationOutputBindingRequest
  agent: string
  workspaceId: string | null
  issuedAt: number
  expiresAt: number
  binding?: AutomationOutputBinding
}

const grantsByStore = new WeakMap<object, Map<string, BindingGrant>>()

export function createAutomationDispatchRequest(
  store: object,
  automation: Automation,
  run: AutomationRun
): AutomationDispatchRequest {
  const outputBinding = createAutomationOutputBindingRequest(store, automation, run)
  return {
    automation,
    run,
    dispatchToken: createAutomationDispatchToken(automation.id, run.id),
    launchProvenance: createAutomationLaunchProvenanceGrant(store, automation, run),
    ...(outputBinding ? { outputBinding } : {})
  }
}

function grants(store: object): Map<string, BindingGrant> {
  let entries = grantsByStore.get(store)
  if (!entries) {
    entries = new Map()
    grantsByStore.set(store, entries)
  }
  for (const [runId, entry] of entries) {
    if (entry.expiresAt <= Date.now()) {
      entries.delete(runId)
    }
  }
  return entries
}

/** Issued only by the host dispatcher; never reconstructed from mutable saved run IDs. */
export function createAutomationOutputBindingRequest(
  store: object,
  automation: Automation,
  run: AutomationRun
): AutomationOutputBindingRequest | undefined {
  if (
    !automation.structuredOutput ||
    automation.executionTargetType !== 'local' ||
    run.automationId !== automation.id
  ) {
    return undefined
  }
  const entries = grants(store)
  const prior = entries.get(run.id)
  if (prior) {
    return prior.request.automationId === automation.id ? { ...prior.request } : undefined
  }
  while (entries.size >= MAX_BINDINGS) {
    entries.delete(entries.keys().next().value!)
  }
  const request = {
    automationId: automation.id,
    runId: run.id,
    token: createAutomationDispatchToken(automation.id, run.id)
  }
  entries.set(run.id, {
    request,
    agent: automation.agentId,
    workspaceId: automation.workspaceMode === 'new_per_run' ? null : automation.workspaceId,
    issuedAt: Date.now(),
    expiresAt: Date.now() + DISPATCH_TTL_MS
  })
  return { ...request }
}

/** Read the host dispatch grant without reserving or admitting a launch. */
export function matchesAutomationOutputDispatch(
  store: Pick<Store, 'listAutomationRuns'>,
  request: AutomationOutputBindingRequest | undefined,
  workspaceId: string | undefined,
  agent: string | undefined
): boolean {
  if (
    !request ||
    !isAutomationDispatchTokenCurrent(request) ||
    !isAutomationRunDispatching(store, request)
  ) {
    return false
  }
  const entry = grants(store).get(request.runId)
  return Boolean(
    entry &&
    !entry.binding &&
    entry.request.automationId === request.automationId &&
    entry.request.token === request.token &&
    entry.workspaceId === workspaceId &&
    entry.agent === agent
  )
}

export function matchesAutomationOutputAuthority(
  binding: AutomationOutputBinding,
  authority: OrchestrationCompatibilityTerminalAuthority | null
): boolean {
  return (
    authority !== null &&
    authority.hostScope.kind === 'local' &&
    binding.workspaceId === authority.worktreeId &&
    binding.paneKey === authority.paneKey &&
    binding.terminalHandle === authority.terminalHandle &&
    binding.ptyId === authority.ptyId &&
    binding.processIncarnation === authority.processIncarnation &&
    binding.launchTokenHash === authority.launchTokenHash
  )
}

/** Call only at native fresh-spawn commit or the exact reused-terminal write admission. */
export function bindAutomationOutputLaunch(input: {
  store: object
  request: AutomationOutputBindingRequest | undefined
  authority: OrchestrationCompatibilityTerminalAuthority | null
  agent?: string
  reused?: boolean
}): boolean {
  const { request, authority } = input
  if (!request || !authority || authority.hostScope.kind !== 'local') {
    return false
  }
  const entry = grants(input.store).get(request.runId)
  if (
    !entry ||
    entry.request.automationId !== request.automationId ||
    entry.request.token !== request.token ||
    !authority.launchTokenHash ||
    !authority.processIncarnation ||
    !authority.paneKey ||
    (input.agent !== undefined && input.agent !== entry.agent)
  ) {
    return false
  }
  if (entry.binding) {
    return matchesAutomationOutputAuthority(entry.binding, authority)
  }
  if (
    !entry.workspaceId ||
    entry.workspaceId !== authority.worktreeId ||
    !beginAutomationDispatchTokenUse({
      automationId: request.automationId,
      runId: request.runId,
      token: request.token,
      reservationId: authority.ptyId
    })
  ) {
    return false
  }
  entry.binding = Object.freeze({
    automationId: request.automationId,
    runId: request.runId,
    agent: entry.agent,
    workspaceId: authority.worktreeId,
    paneKey: authority.paneKey,
    terminalHandle: authority.terminalHandle,
    ptyId: authority.ptyId,
    processIncarnation: authority.processIncarnation,
    launchTokenHash: authority.launchTokenHash,
    startedAt: input.reused ? Date.now() : entry.issuedAt
  })
  entry.expiresAt = Date.now() + BOUND_TTL_MS
  finishAutomationDispatchTokenUse({ token: request.token, reservationId: authority.ptyId })
  return true
}

/** Only the in-process headless dispatcher may associate its returned new workspace. */
export function bindHeadlessAutomationOutputLaunch(input: {
  store: object
  request: AutomationOutputBindingRequest | undefined
  authority: OrchestrationCompatibilityTerminalAuthority | null
  agent: string
}): boolean {
  if (input.request && input.authority?.hostScope.kind === 'local') {
    const entry = grants(input.store).get(input.request.runId)
    if (
      entry &&
      entry.request.automationId === input.request.automationId &&
      entry.request.token === input.request.token &&
      entry.agent === input.agent &&
      input.authority.launchTokenHash &&
      input.authority.processIncarnation &&
      input.authority.paneKey &&
      !entry.binding &&
      !entry.workspaceId
    ) {
      entry.workspaceId = input.authority.worktreeId
    }
  }
  return bindAutomationOutputLaunch(input)
}

/** Called only after the host successfully creates a workspace using the reserved dispatch token. */
export function bindAutomationOutputWorkspace(
  store: object,
  request: AutomationWorkspaceProvenanceRequest | undefined,
  workspaceId: string
): void {
  if (!request || !workspaceId) {
    return
  }
  bindAutomationLaunchWorkspace(store, request, workspaceId)
  const entry = grants(store).get(request.automationRunId)
  if (
    entry?.request.automationId === request.automationId &&
    !entry.binding &&
    !entry.workspaceId
  ) {
    entry.workspaceId = workspaceId
  }
}

export function readAutomationOutputBinding(
  store: object,
  run: Pick<AutomationRun, 'id' | 'automationId'>
): AutomationOutputBinding | null {
  const binding = grants(store).get(run.id)?.binding
  return binding?.automationId === run.automationId ? binding : null
}

export function nativeLaunchMatchesAutomationBinding(
  binding: AutomationOutputBinding,
  launchToken: string | undefined
): boolean {
  return Boolean(
    launchToken &&
    createHash('sha256').update(launchToken).digest('hex') === binding.launchTokenHash
  )
}
