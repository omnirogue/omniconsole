import { createAgentSessionOperationId } from './agent-session-operation-id'
import type { WebSessionIntentOwner } from './web-session-intent-owner'
import type { WebRuntimeTerminalCreateOutcome } from './web-runtime-session-types'
import { toHostSessionTabId } from './web-terminal-surface-id'

type AutomaticTerminalCreate = {
  clientMutationId: string
  inFlight: boolean
  createdTabId?: string
  observedTabIds: Set<string>
}

const automaticTerminalCreates = new Map<string, AutomaticTerminalCreate>()
const STORAGE_KEY_PREFIX = 'orca:automatic-terminal-create:v1:'

function ownerWorkspaceKey(owner: WebSessionIntentOwner, worktreeId: string): string {
  return JSON.stringify([owner.environmentId, owner.pairingRevision ?? null, worktreeId])
}

function readAutomaticTerminalCreate(key: string): AutomaticTerminalCreate | undefined {
  const current = automaticTerminalCreates.get(key)
  if (current) {
    return current
  }
  try {
    const stored =
      typeof window !== 'undefined'
        ? window.sessionStorage?.getItem(STORAGE_KEY_PREFIX + key)
        : null
    if (!stored) {
      return undefined
    }
    const record: unknown = JSON.parse(stored)
    if (
      !record ||
      typeof record !== 'object' ||
      !('clientMutationId' in record) ||
      typeof record.clientMutationId !== 'string' ||
      !record.clientMutationId ||
      record.clientMutationId.length > 128
    ) {
      return undefined
    }
    const operation: AutomaticTerminalCreate = {
      clientMutationId: record.clientMutationId,
      inFlight: false,
      observedTabIds: new Set(),
      ...('createdTabId' in record && typeof record.createdTabId === 'string'
        ? { createdTabId: record.createdTabId }
        : {})
    }
    automaticTerminalCreates.set(key, operation)
    return operation
  } catch {
    return undefined
  }
}

function persistAutomaticTerminalCreate(key: string, operation: AutomaticTerminalCreate): void {
  try {
    if (typeof window !== 'undefined') {
      window.sessionStorage?.setItem(
        STORAGE_KEY_PREFIX + key,
        JSON.stringify({
          clientMutationId: operation.clientMutationId,
          ...(operation.createdTabId ? { createdTabId: operation.createdTabId } : {})
        })
      )
    }
  } catch {
    // Storage availability does not change the current renderer's hold.
  }
}

function forgetAutomaticTerminalCreate(key: string): void {
  automaticTerminalCreates.delete(key)
  try {
    if (typeof window !== 'undefined') {
      window.sessionStorage?.removeItem(STORAGE_KEY_PREFIX + key)
    }
  } catch {
    // Keep storage failures local to this optional reload protection.
  }
}

export function beginWebRuntimeAutomaticTerminalCreate(
  owner: WebSessionIntentOwner,
  worktreeId: string
): {
  clientMutationId: string
  onSessionCreated: (tabId: string) => void
  finish: (outcome: WebRuntimeTerminalCreateOutcome | undefined) => void
} | null {
  const key = ownerWorkspaceKey(owner, worktreeId)
  if (readAutomaticTerminalCreate(key)) {
    return null
  }
  const operation: AutomaticTerminalCreate = {
    clientMutationId: createAgentSessionOperationId(),
    inFlight: true,
    observedTabIds: new Set()
  }
  automaticTerminalCreates.set(key, operation)
  persistAutomaticTerminalCreate(key, operation)
  return {
    clientMutationId: operation.clientMutationId,
    onSessionCreated(tabId) {
      if (automaticTerminalCreates.get(key) !== operation) {
        return
      }
      operation.createdTabId = toHostSessionTabId(tabId)
      persistAutomaticTerminalCreate(key, operation)
    },
    finish(outcome) {
      if (automaticTerminalCreates.get(key) !== operation) {
        return
      }
      operation.inFlight = false
      // Unknown creation stays held until its exact ready host tab is observed.
      if (
        (operation.createdTabId && operation.observedTabIds.has(operation.createdTabId)) ||
        (outcome?.status === 'failed' && !outcome.creationUnverifiable)
      ) {
        forgetAutomaticTerminalCreate(key)
      }
    }
  }
}

export function observeWebRuntimeAutomaticTerminalCreate(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  readyHostTabIds: readonly string[]
): void {
  const key = ownerWorkspaceKey(owner, worktreeId)
  const operation = readAutomaticTerminalCreate(key)
  if (!operation) {
    return
  }
  operation.observedTabIds = new Set(readyHostTabIds)
  if (
    !operation.inFlight &&
    operation.createdTabId &&
    operation.observedTabIds.has(operation.createdTabId)
  ) {
    forgetAutomaticTerminalCreate(key)
  }
}

export function resetWebRuntimeAutomaticTerminalCreatesForTests(
  options: { preserveStorage?: boolean } = {}
): void {
  automaticTerminalCreates.clear()
  if (options.preserveStorage) {
    return
  }
  try {
    if (typeof window !== 'undefined') {
      const storage = window.sessionStorage
      for (let index = (storage?.length ?? 0) - 1; index >= 0; index -= 1) {
        const key = storage.key(index)
        if (key?.startsWith(STORAGE_KEY_PREFIX)) {
          storage.removeItem(key)
        }
      }
    }
  } catch {
    // Test cleanup also runs in non-browser storage fixtures.
  }
}
