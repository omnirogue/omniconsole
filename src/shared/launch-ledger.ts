import type { LaunchActor, LaunchReference } from './launch-cause'
import type { LaunchTrigger } from './launch-trigger'

export type LaunchLedgerRow = {
  v: 1
  ts: string
  pipeline: 'renderer-ipc' | 'runtime-controller' | 'structured-agent-session'
  ptyId: string | null
  launchId?: string
  incarnationId?: string
  paneKey?: string
  tabId?: string
  worktreeId?: string
  agent?: string
  cause: LaunchTrigger
  reference?: LaunchReference
  actor?: LaunchActor
  requestId?: string
  requestIdHash?: string
  clientMutationIdHash?: string
  claimedTrigger?: LaunchTrigger
  claimedTriggerHash?: string
  claimedReference?: LaunchReference
  claimedReferenceHashes?: LaunchReference
  parentPaneKey?: string
  hasStartupCommand: boolean
  visible?: boolean
  intent?: 'attach' | 'create-or-attach'
  outcome?: 'failed-after-start'
  process: 'attachment-intent' | 'prepared' | 'created' | 'attached' | 'failed' | 'unknown'
}

export type RuntimeTerminalWhy = {
  terminal: string
  ptyId: string | null
  paneKey: string | null
  launch: LaunchLedgerRow | null
  attachments?: LaunchLedgerRow[]
  currentStartUnrecorded?: boolean
  previousCreations?: LaunchLedgerRow[]
}
