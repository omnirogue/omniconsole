import type { AgentStatusObservation } from '../../shared/agent-status-observation'
import type { PtyLaunchGateObservation, PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import type { ManagedSessionProcess, ManagedSessionProvider } from './managed-session-process'

export type ManagedSessionPrincipal = Readonly<{ clerk_user_id: string; employee_id: string }>
export type ManagedSessionTerminal = {
  handle: string
  paneKey: string
  ptyId: string
  incarnationId: string
  launchToken: string
}
export type ManagedSessionHook = {
  provider: ManagedSessionProvider
  providerSessionId: string
  agentPid: number
  observation: AgentStatusObservation
  onAttachedPty: boolean
  updatedAt: number
}
export type ManagedSessionAuthority = Readonly<{ nativeOperationId: string }>
export type CreateInput = {
  nativeOperationId: string
  externalOperationId: string
  runtimeId: string
  principal: ManagedSessionPrincipal
  provider: ManagedSessionProvider
  seededProviderSessionId?: string
  terminal: ManagedSessionTerminal
  gate: PtyLaunchGateReceipt
  createdAtMs: number
  startAcknowledgement: string
}
export type ManagedSessionAuthorityInspection = {
  authority_verified: boolean
  agent_live: boolean | null
  operation_id: string
  managed_operation_id: string
  principal: ManagedSessionPrincipal
  provider: ManagedSessionProvider
  terminal_handle: string
  pane_key: string
  pty_incarnation: string
  provider_session_id: string | null
  state: 'live' | 'unverifiable' | 'exited'
  phase: 'startup' | 'bound'
  reason: string
}
export type ManagedSessionAuthorityReaders = {
  runtimeId: string
  now?: () => number
  readGate: (gate: PtyLaunchGateReceipt) => Promise<PtyLaunchGateObservation | null>
  readTerminal: (handle: string) => ManagedSessionTerminal | null
  readHook: (handle: string) => ManagedSessionHook | null
  readProcess: (pid: number) => Promise<ManagedSessionProcess | null>
}
type Binding = { hook: ManagedSessionHook; process: ManagedSessionProcess }
export type PrivateAuthority = {
  input: CreateInput
  bound: Binding | null
  revoked: string | null
  exited: boolean
  pending: Promise<void>
}
