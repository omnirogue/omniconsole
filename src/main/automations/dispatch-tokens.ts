import { randomUUID } from 'node:crypto'
import type {
  Automation,
  AutomationLaunchProvenanceRequest,
  AutomationRun
} from '../../shared/automations-types'
import type { AutomationWorkspaceProvenanceRequest } from '../../shared/worktree/types'
import type { Store } from '../persistence'

const DISPATCH_TOKEN_TTL_MS = 30 * 60_000

type DispatchTokenRecord = {
  automationId: string
  runId: string
  expiresAt: number
  reservedBy?: string
  inFlight: boolean
  launchScope?: { store: object; workspaceId: string | null; agent: string }
}

const dispatchTokens = new Map<string, DispatchTokenRecord>()

function pruneExpiredDispatchTokens(now = Date.now()): void {
  for (const [token, record] of dispatchTokens) {
    if (record.expiresAt <= now) {
      dispatchTokens.delete(token)
    }
  }
}

export function createAutomationDispatchToken(automationId: string, runId: string): string {
  pruneExpiredDispatchTokens()
  const token = randomUUID()
  dispatchTokens.set(token, {
    automationId,
    runId,
    expiresAt: Date.now() + DISPATCH_TOKEN_TTL_MS,
    inFlight: false
  })
  return token
}

export function beginAutomationDispatchTokenUse(args: {
  automationId: string
  runId: string
  token: string
  reservationId: string
}): boolean {
  pruneExpiredDispatchTokens()
  const record = dispatchTokens.get(args.token)
  const valid =
    record?.automationId === args.automationId &&
    record.runId === args.runId &&
    record.expiresAt > Date.now()
  if (!valid) {
    return false
  }
  if (record.reservedBy !== undefined && record.reservedBy !== args.reservationId) {
    return false
  }
  if (record.inFlight) {
    return false
  }
  record.reservedBy = args.reservationId
  record.inFlight = true
  return true
}

export function releaseAutomationDispatchTokenUse(args: {
  token: string
  reservationId: string
}): void {
  const record = dispatchTokens.get(args.token)
  if (record?.reservedBy === args.reservationId) {
    record.inFlight = false
  }
}

export function finishAutomationDispatchTokenUse(args: {
  token: string
  reservationId: string
}): void {
  const record = dispatchTokens.get(args.token)
  if (record?.reservedBy === args.reservationId) {
    dispatchTokens.delete(args.token)
  }
}

export function clearAutomationDispatchTokens(automationId: string, runId: string): void {
  for (const [token, record] of dispatchTokens) {
    if (record.automationId === automationId && record.runId === runId) {
      dispatchTokens.delete(token)
    }
  }
}

/** A description grant is independent of output binding and launch admission. */
export function createAutomationLaunchProvenanceGrant(
  store: object,
  automation: Automation,
  run: AutomationRun
): AutomationLaunchProvenanceRequest {
  const token = createAutomationDispatchToken(automation.id, run.id)
  dispatchTokens.get(token)!.launchScope = {
    store,
    workspaceId: automation.workspaceMode === 'new_per_run' ? null : automation.workspaceId,
    agent: automation.agentId
  }
  return { automationId: automation.id, runId: run.id, token }
}

export function isAutomationDispatchTokenCurrent(
  request: AutomationLaunchProvenanceRequest
): boolean {
  const record = dispatchTokens.get(request.token)
  return Boolean(
    record &&
    record.automationId === request.automationId &&
    record.runId === request.runId &&
    record.expiresAt > Date.now()
  )
}

export function isAutomationRunDispatching(
  store: Pick<Store, 'listAutomationRuns'>,
  request: AutomationLaunchProvenanceRequest
): boolean {
  return store
    .listAutomationRuns()
    .some(
      (run) =>
        run.id === request.runId &&
        run.automationId === request.automationId &&
        run.status === 'dispatching'
    )
}

/** Reading provenance never reserves or consumes an output/workspace token. */
export function matchesAutomationLaunchDispatch(
  store: Pick<Store, 'listAutomationRuns'>,
  request: AutomationLaunchProvenanceRequest | undefined,
  workspaceId: string | undefined,
  agent: string | undefined
): boolean {
  if (!request || !isAutomationDispatchTokenCurrent(request)) {
    return false
  }
  const scope = dispatchTokens.get(request.token)?.launchScope
  return Boolean(
    scope &&
    scope.store === store &&
    scope.workspaceId === workspaceId &&
    scope.agent === agent &&
    isAutomationRunDispatching(store, request)
  )
}

export function bindAutomationLaunchWorkspace(
  store: object,
  request: AutomationWorkspaceProvenanceRequest,
  workspaceId: string
): void {
  if (
    !isAutomationDispatchTokenCurrent({
      automationId: request.automationId,
      runId: request.automationRunId,
      token: request.dispatchToken
    })
  ) {
    return
  }
  for (const record of dispatchTokens.values()) {
    const scope = record.launchScope
    if (
      record.automationId === request.automationId &&
      record.runId === request.automationRunId &&
      scope?.store === store &&
      scope.workspaceId === null
    ) {
      scope.workspaceId = workspaceId
    }
  }
}
