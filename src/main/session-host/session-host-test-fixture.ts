/**
 * Test hosts for session host admission: a registry in a temporary directory, "processes" that are
 * separate `SessionHostProcess` instances on it (a crash is abandoning one and declaring it dead),
 * and an executor whose turn, dispatches and hangs the test controls.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionHostOrigin } from '../../shared/session-host-authority'
import {
  SESSION_HOST_CAPABILITIES,
  type SessionHostCapability
} from '../../shared/session-host-capabilities'
import type { SessionHostRequest } from '../../shared/session-host-protocol'
import { FIXTURE_ORIGIN } from '../../shared/session-host-request-fixtures'
import { FIXTURE_NOW, fixtureOperationId } from '../../shared/session-host-wire-fixtures'
import type {
  SessionHostExecutionInput,
  SessionHostExecutor,
  SessionHostLiveObservation,
  SessionHostPrepared
} from './session-host-executor'
import type { SessionHostRegistration } from './session-host-journal'
import { registerSessionHostConversation } from './session-host-ownership-registry'
import { SessionHostProcess } from './session-host-process'
import type { SessionHostService } from './session-host-service'
import type { SessionHostSettlement } from './session-host-settlement'

export const TEST_NOW = FIXTURE_NOW + 60_000

export class FakeSessionHostExecutor implements SessionHostExecutor {
  turn: string | null = 'turn:1'
  organization: string | null = 'org:1'
  caps: SessionHostCapability[] = [...SESSION_HOST_CAPABILITIES]
  /** Every operation whose dispatch actually ran: the "bytes moved" count. */
  readonly dispatched: string[] = []
  prepareRefusal: SessionHostPrepared | null = null
  /** When set, dispatch runs this after recording (e.g. a promise that never settles = a crash). */
  afterDispatch: (() => Promise<SessionHostSettlement>) | null = null
  beforeDispatch: (() => Promise<void>) | null = null
  register?: () => Promise<void>
  readonly marks: string[] = []

  capabilities(): readonly SessionHostCapability[] {
    return this.caps
  }

  reconciled(): boolean {
    return true
  }

  async readTurn(): Promise<{ turnRevision: string | null; organizationRevision: string | null }> {
    return { turnRevision: this.turn, organizationRevision: this.organization }
  }

  async observe(
    registrations: readonly SessionHostRegistration[]
  ): Promise<ReadonlyMap<string, SessionHostLiveObservation>> {
    return new Map(
      registrations.map((registration) => [
        registration.conversationId,
        {
          verdict: 'live' as const,
          turnRevision: this.turn,
          organizationRevision: this.organization ?? undefined
        }
      ])
    )
  }

  async prepare(input: SessionHostExecutionInput): Promise<SessionHostPrepared> {
    if (this.prepareRefusal) {
      return this.prepareRefusal
    }
    this.marks.push(input.marker)
    return {
      kind: 'dispatch',
      dispatch: async () => {
        await this.beforeDispatch?.()
        this.dispatched.push(input.operation.operationId)
        return this.afterDispatch
          ? await this.afterDispatch()
          : { kind: 'completed', result: { delivered: input.operation.operationId } }
      }
    }
  }

  async tidy(): Promise<never> {
    throw new Error('not used')
  }

  async history(): Promise<never> {
    throw new Error('not used')
  }

  async waitStatus(): Promise<never> {
    throw new Error('not used')
  }
}

export type TestHostRoot = { root: string; dispose: () => void }

export function testHostRoot(): TestHostRoot {
  const root = mkdtempSync(join(tmpdir(), 'session-host-'))
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

/** A host process on `root`; `dead` names the incarnations the new one may treat as gone. */
export function testHostProcess(input: {
  root: string
  incarnation: string
  executor?: SessionHostExecutor
  dead?: readonly string[]
  kind?: 'paired-runtime' | 'ssh-relay'
}): SessionHostProcess {
  const process = new SessionHostProcess({
    kind: input.kind ?? 'paired-runtime',
    incarnation: input.incarnation,
    root: input.root,
    now: () => TEST_NOW,
    processIdentity: async () => `identity-${input.incarnation}`,
    liveness: async (controller) =>
      input.dead?.includes(controller.incarnation) ? 'dead' : 'alive'
  })
  if (input.executor) {
    process.installExecutor(input.executor)
  }
  return process
}

export async function adoptTestConversation(
  service: SessionHostService,
  sessionId = 'claude-session-1'
): Promise<SessionHostRegistration> {
  const result = await registerSessionHostConversation(service.store, {
    provider: { agent: 'claude', sessionId },
    binding: { worktreeId: 'wt-1', paneKey: `tab-1:${sessionId}`, kind: 'pty' },
    workspace: { kind: 'folder', path: '/work/release' },
    processIncarnation: 'pid-100',
    adopted: true
  })
  if (result.status !== 'ok') {
    throw new Error(result.refusal.message)
  }
  return result.registration
}

export const MAC_A: SessionHostOrigin = { ...FIXTURE_ORIGIN, computer: 'Studio' }
export const MAC_B: SessionHostOrigin = {
  computer: 'Laptop',
  requester: { kind: 'person', via: 'sidebar' }
}

export function continueRequest(
  n: number,
  conversationId: string,
  extra: Partial<SessionHostRequest<'continue'>> = {}
): SessionHostRequest<'continue'> {
  return {
    operationId: fixtureOperationId(n),
    conversationId,
    expectedOwnerEpoch: 1,
    expectedTurnRevision: 'turn:1',
    origin: MAC_A,
    action: 'continue',
    payload: { answer: { kind: 'prompt', text: `Carry on (${n}).` } },
    ...extra
  }
}

export function remote(peer: string, origin: SessionHostOrigin = MAC_A) {
  return { kind: 'remote' as const, transport: 'paired-runtime' as const, peer, origin }
}

export function withoutOrigin<T extends { origin: unknown }>(request: T): Omit<T, 'origin'> {
  const { origin: _origin, ...rest } = request
  return rest
}
