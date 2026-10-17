import {
  getNativePeerInboxRecord as recordFor,
  nativePeerInboxBindingKey as bindingKey,
  buildNativePeerInboxHint
} from './native-peer-inbox-binding'
import type {
  NativePeerInboxBinding,
  NativePeerInboxReceipt
} from '../../shared/native-peer-inbox-binding'
import { isNativePeerInboxBinding } from '../../shared/native-peer-inbox-binding'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import type { OrcaRuntimeService } from './omni-runtime'
import { PeerInboxReceiver, type PeerInboxReceiverStatus } from './peer-inbox-receiver'
import { readPeerInboxPending } from './peer-inbox-pending-client'
import { queuePeerInboxCodexHint } from './peer-inbox-codex-queue'
import { probeAgentSessionProcessIdentity } from './agent-session-process-identity-probe'

type Runtime = Pick<
  OrcaRuntimeService,
  | 'getRuntimeId'
  | 'getTerminalProcessIncarnation'
  | 'getTerminalPaneKey'
  | 'getTerminalWorktreeIdForPaneKey'
  | 'resolveLiveLeafForHandle'
  | 'subscribeToPtyExit'
>
type Entry = {
  binding: NativePeerInboxBinding
  receiver: PeerInboxReceiver<NativePeerInboxBinding>
  stopExit: () => void
}

export class NativePeerInboxOwner {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly runtime: Runtime) {}

  private isNativeTarget(binding: NativePeerInboxBinding): boolean {
    try {
      const record = recordFor(binding)
      const leaf = this.runtime.resolveLiveLeafForHandle(binding.terminalHandle)
      return (
        this.runtime.getRuntimeId() === binding.runtimeId &&
        this.runtime.getTerminalProcessIncarnation(binding.terminalHandle) ===
          binding.incarnation &&
        this.runtime.getTerminalPaneKey(binding.terminalHandle) === binding.paneKey &&
        this.runtime.getTerminalWorktreeIdForPaneKey(binding.paneKey) === binding.workspaceId &&
        leaf?.ptyId === binding.ptyId &&
        agentSessionPtyWriteGate.boundSessionId(binding.ptyId) === binding.nativeSessionId &&
        bindingKey(binding, record) === binding.key
      )
    } catch {
      return false
    }
  }

  private isCurrent(binding: NativePeerInboxBinding): boolean {
    return (
      this.isNativeTarget(binding) &&
      JSON.stringify(recordFor(binding).peerInbox?.binding) === JSON.stringify(binding)
    )
  }

  async bind(input: NativePeerInboxBinding): Promise<PeerInboxReceiverStatus> {
    if (!isNativePeerInboxBinding(input)) {
      throw new Error('peer_inbox_binding_invalid')
    }
    const record = recordFor(input)
    const binding = Object.freeze({ ...input, key: bindingKey(input, record) })
    if (!this.isNativeTarget(binding)) {
      throw new Error('peer_inbox_native_binding_unverifiable')
    }
    if (buildNativePeerInboxHint(binding, '00000000-0000-4000-8000-000000000000').length > 2048) {
      throw new Error('peer_inbox_binding_too_large')
    }
    const current = this.entries.get(binding.terminalHandle)
    if (current) {
      if (current.binding.key !== binding.key) {
        throw new Error('peer_inbox_already_bound')
      }
      return current.receiver.getStatus()
    }
    const store = getStructuredAgentSessionHost()!.deps.store
    const expected = record.peerInbox
    if (
      expected &&
      JSON.stringify(expected.binding) !== JSON.stringify(binding) &&
      expected.attempt &&
      !['completed', 'not-written'].includes(expected.attempt.outcome)
    ) {
      throw new Error('peer_inbox_submission_unresolved')
    }
    const next: NativePeerInboxReceipt = {
      binding,
      attempt: expected?.binding.key === binding.key ? expected.attempt : null
    }
    await store.replacePeerInbox({
      sessionId: binding.nativeSessionId,
      fence: binding.runtimeFence,
      expected,
      next,
      now: Date.now()
    })
    if (!this.isCurrent(binding)) {
      throw new Error('peer_inbox_native_binding_unverifiable')
    }
    if (this.entries.has(binding.terminalHandle)) {
      throw new Error('peer_inbox_already_bound')
    }
    const receiver = this.createReceiver(binding)
    const stopExit = this.runtime.subscribeToPtyExit(binding.ptyId, () =>
      this.stop(binding.terminalHandle)
    )
    this.entries.set(binding.terminalHandle, { binding, receiver, stopExit })
    receiver.start()
    return receiver.getStatus()
  }

  private async updateAttempt(
    binding: NativePeerInboxBinding,
    attempt: NativePeerInboxReceipt['attempt']
  ): Promise<void> {
    if (!this.isCurrent(binding)) {
      throw new Error('peer_inbox_binding_changed')
    }
    const store = getStructuredAgentSessionHost()!.deps.store
    const record = recordFor(binding)
    await store.replacePeerInbox({
      sessionId: binding.nativeSessionId,
      fence: binding.runtimeFence,
      expected: record.peerInbox,
      next: { binding, attempt },
      now: Date.now()
    })
  }

  private createReceiver(
    binding: NativePeerInboxBinding
  ): PeerInboxReceiver<NativePeerInboxBinding> {
    return new PeerInboxReceiver(
      binding,
      {
        isCurrent: (value) => this.isCurrent(value),
        readPending: (signal) => readPeerInboxPending(binding, { signal }),
        admit: (value) =>
          !this.isCurrent(value) ? 'revoked' : value.wakeConsent ? 'ready' : 'consent',
        loadAttempt: async (value) => {
          const attempt = recordFor(value).peerInbox?.attempt
          return attempt ? { nonce: attempt.nonce } : null
        },
        persistAttempt: (value, attempt) =>
          this.updateAttempt(value, { ...attempt, outcome: 'uncertain' }),
        clearAttempt: async (value, nonce, evidence) => {
          const attempt = recordFor(value).peerInbox?.attempt
          if (!attempt && evidence === 'not-written') {
            return
          }
          if (attempt?.nonce !== nonce) {
            throw new Error('peer_inbox_attempt_changed')
          }
          if (attempt.outcome === 'uncertain' && evidence === 'not-written') {
            await this.updateAttempt(value, { ...attempt, outcome: 'not-written' })
          } else if (!['completed', 'not-written'].includes(attempt.outcome)) {
            throw new Error('peer_inbox_submission_unresolved')
          }
          await this.updateAttempt(value, null)
        },
        submitHint: async (value, nonce, signal) => {
          if (!this.isCurrent(value) || !value.wakeConsent) {
            return 'not-written'
          }
          const ownerProcess = recordFor(value).lease.ownerProcess
          if (!ownerProcess) {
            return 'not-written'
          }
          const proof = await probeAgentSessionProcessIdentity({ identity: ownerProcess })
          if (proof.outcome !== 'identity-matched' || !this.isCurrent(value) || signal.aborted) {
            return 'not-written'
          }
          const result = await queuePeerInboxCodexHint({
            record: recordFor(value),
            threadId: value.providerSessionId,
            hint: buildNativePeerInboxHint(value, nonce),
            correlationNonce: nonce,
            signal
          })
          if (!this.isCurrent(value)) {
            return 'uncertain'
          }
          if (result.status === 'queued') {
            if (recordFor(value).peerInbox?.attempt?.outcome !== 'completed') {
              await this.updateAttempt(value, {
                nonce,
                nativeItemId: result.nativeItemId,
                outcome: 'submitted'
              })
            }
            return 'submitted'
          }
          if (result.status === 'not-started') {
            return 'not-written'
          }
          return 'uncertain'
        },
        observeAttempt: async (value, nonce) => {
          const attempt = recordFor(value).peerInbox?.attempt
          if (attempt?.nonce !== nonce) {
            throw new Error('peer_inbox_attempt_changed')
          }
          return attempt.outcome === 'completed'
            ? 'completed'
            : attempt.outcome === 'not-written'
              ? 'not-written'
              : 'unresolved'
        }
      },
      { pollIntervalMs: 5_000 }
    )
  }

  // This settles the native hint only. Canonical inbox/ACK/reply remain model-owned.
  async complete(terminal: string, key: string, nonce: string): Promise<PeerInboxReceiverStatus> {
    const entry = this.entries.get(terminal)
    if (!entry || entry.binding.key !== key || !this.isCurrent(entry.binding)) {
      throw new Error('peer_inbox_binding_changed')
    }
    const attempt = recordFor(entry.binding).peerInbox?.attempt
    if (attempt?.nonce !== nonce) {
      throw new Error('peer_inbox_attempt_changed')
    }
    await this.updateAttempt(entry.binding, { ...attempt, outcome: 'completed' })
    entry.receiver.notifyOwnerChanged()
    return entry.receiver.getStatus()
  }

  status(
    terminal: string
  ):
    | (PeerInboxReceiverStatus & {
        nativeQueueItemId?: string
        enrollment?: { projectId: string; taskId: string; peerSessionId: string; provider: string }
      })
    | null {
    const entry = this.entries.get(terminal)
    if (!entry) {
      return null
    }
    const receipt = getStructuredAgentSessionHost()?.deps.store.getRecord(
      entry.binding.nativeSessionId
    )?.peerInbox
    return {
      ...entry.receiver.getStatus(),
      enrollment: {
        projectId: entry.binding.projectId,
        taskId: entry.binding.taskId,
        peerSessionId: entry.binding.peerSessionId,
        provider: entry.binding.provider
      },
      ...(receipt?.attempt?.nativeItemId ? { nativeQueueItemId: receipt.attempt.nativeItemId } : {})
    }
  }

  notify(paneKey: string): void {
    for (const entry of this.entries.values()) {
      if (entry.binding.paneKey === paneKey) {
        entry.receiver.notifyOwnerChanged()
      }
    }
  }

  stop(terminal: string): void {
    const entry = this.entries.get(terminal)
    if (!entry) {
      return
    }
    this.entries.delete(terminal)
    entry.receiver.dispose()
    entry.stopExit()
  }

  stopPane(paneKey: string): void {
    for (const entry of this.entries.values()) {
      if (entry.binding.paneKey === paneKey) {
        this.stop(entry.binding.terminalHandle)
      }
    }
  }
}

const owners = new WeakMap<Runtime, NativePeerInboxOwner>()

export function getNativePeerInboxOwner(runtime: Runtime): NativePeerInboxOwner {
  let owner = owners.get(runtime)
  if (!owner) {
    owner = new NativePeerInboxOwner(runtime)
    owners.set(runtime, owner)
  }
  return owner
}

export function notifyNativePeerInboxOwner(
  runtime: Runtime,
  paneKey: string,
  retired = false
): void {
  const owner = owners.get(runtime)
  if (retired) {
    owner?.stopPane(paneKey)
  } else {
    owner?.notify(paneKey)
  }
}

export { buildNativePeerInboxHint } from './native-peer-inbox-binding'
