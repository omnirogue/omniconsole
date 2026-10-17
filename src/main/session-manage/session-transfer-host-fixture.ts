/**
 * Test computers for transfers and relocation: each is a real session host (its own registry in a
 * temporary directory) whose executor runs the real transfer steps, with provider homes on disk and
 * fake panes. session-transfer-port-fixture.ts opens them and reaches them as another Mac would.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionHostOrigin } from '../../shared/session-host-authority'
import type { SessionHostRelocationProvider } from '../../shared/session-host-capabilities'
import { encodeClaudeProjectPath } from '../ai-vault/claude-project-dir-encoding'
import type { SessionHostTurnReading } from '../session-host/session-host-admission-facts'
import type {
  SessionHostExecutionInput,
  SessionHostExecutor,
  SessionHostLiveObservation,
  SessionHostPrepared
} from '../session-host/session-host-executor'
import type { SessionHostRegistration } from '../session-host/session-host-journal'
import { registerSessionHostConversation } from '../session-host/session-host-ownership-registry'
import type { SessionHostService } from '../session-host/session-host-service'
import type { SessionTransferHostActionDeps } from './session-transfer-host-action-deps'
import {
  sessionTransferHostActions,
  type SessionTransferHostActions
} from './session-transfer-host-actions'

export const PERSON_ON_STUDIO: SessionHostOrigin = {
  computer: 'Studio',
  requester: { kind: 'person', via: 'sidebar' }
}
export const STEWARD_ON_STUDIO: SessionHostOrigin = {
  computer: 'Studio',
  requester: { kind: 'cli', unattended: { source: 'rules' } }
}

/** A computer's live pieces, controllable by the test. */
export class TestComputer implements SessionHostExecutor {
  readonly home: string
  readonly turns = new Map<string, string>()
  readonly frozen = new Set<string>()
  readonly launched: { sessionId: string; transcriptPath: string }[] = []
  readonly retired: string[] = []
  readonly archived: { conversationId: string; reason: string }[] = []
  readonly briefs = new Map<string, string>()
  readonly delivered: string[] = []
  relocationOn = true
  stops = true
  /** A crash inside relinquishment: the tombstone is written, then this process never returns. */
  retireHangs = false
  /** What the provider "reports" after launch; default: the id recorded in the transcript itself. */
  reports: ((transcriptPath: string) => string | null) | null = null
  service!: SessionHostService
  private handler: SessionTransferHostActions | null = null

  constructor(
    readonly name: string,
    readonly root: string
  ) {
    this.home = join(root, 'home')
  }

  actions(): SessionTransferHostActions {
    this.handler ??= sessionTransferHostActions(this.deps())
    return this.handler
  }

  capabilities() {
    // Why guarded: a process may ask before the test opened this computer's service.
    return this.service ? this.actions().capabilities() : []
  }

  reconciled(): boolean {
    return true
  }

  async readTurn(registration: SessionHostRegistration): Promise<SessionHostTurnReading> {
    return {
      turnRevision: registration.binding
        ? (this.turns.get(registration.conversationId) ?? 'turn:1')
        : null,
      organizationRevision: 'org:1'
    }
  }

  async observe(
    registrations: readonly SessionHostRegistration[]
  ): Promise<ReadonlyMap<string, SessionHostLiveObservation>> {
    return new Map(
      registrations.map((registration) => [
        registration.conversationId,
        {
          verdict: this.frozen.has(registration.conversationId)
            ? ('exited' as const)
            : ('live' as const),
          turnRevision: registration.binding
            ? (this.turns.get(registration.conversationId) ?? 'turn:1')
            : null,
          organizationRevision: 'org:1'
        }
      ])
    )
  }

  async prepare(input: SessionHostExecutionInput): Promise<SessionHostPrepared> {
    if (this.actions().handles(input.request.action)) {
      return await this.actions().prepare(input)
    }
    return {
      kind: 'dispatch',
      dispatch: async () => {
        this.delivered.push(`${input.request.action}:${input.request.conversationId}`)
        return { kind: 'completed', result: { delivered: true } }
      }
    }
  }

  private deps(): SessionTransferHostActionDeps {
    return {
      store: this.service.store,
      relocationEnabled: () => this.relocationOn,
      relocationProviders: () => ['claude', 'codex'],
      transferSource: {
        eligible: async () => null,
        askBrief: async ({ registration, marker, question }) => {
          const id = registration.conversationId
          this.delivered.push(`${marker}${question}`)
          const next = `turn:${Number((this.turns.get(id) ?? 'turn:1').slice(5)) + 1}`
          this.turns.set(id, next)
          return { reply: this.briefs.get(id) ?? `Brief of ${id}`, turnRevision: next }
        },
        archive: async ({ registration, reason }) => {
          this.archived.push({ conversationId: registration.conversationId, reason })
          return { archived: true }
        }
      },
      relocationSource: {
        freeze: async ({ registration }) => {
          if (!this.stops) {
            return { stopped: false, reason: 'a child process is still running' }
          }
          this.frozen.add(registration.conversationId)
          return { stopped: true, evidence: 'provider and children exited' }
        },
        exitEvidence: async (registration) =>
          this.frozen.has(registration.conversationId)
            ? { stopped: true, evidence: 'still exited' }
            : { stopped: false, reason: 'running' },
        transcriptPath: async (registration) => this.transcriptOf(registration.provider),
        retire: async ({ registration }) => {
          this.retired.push(registration.conversationId)
          if (this.retireHangs) {
            await new Promise(() => {})
          }
        }
      },
      relocationDestination: {
        check: async (payload) => ({
          ok: true,
          providerRoot: this.providerRoot(payload.provider),
          workspace: { kind: 'folder', path: `/work/${this.name}` },
          providerVersion: payload.providerVersion
        }),
        launch: async ({ identity }) => {
          this.launched.push({
            sessionId: identity.sessionId,
            transcriptPath: identity.transcriptPath
          })
          const binding: ConversationSource = {
            worktreeId: `wt-${this.name}`,
            paneKey: `tab-${this.launched.length}:leaf-1`,
            kind: 'pty'
          }
          return { binding, processIncarnation: `pid-${this.launched.length}` }
        },
        confirm: async () => {
          const last = this.launched.at(-1)!
          const reported = this.reports
            ? this.reports(last.transcriptPath)
            : transcriptIdentity(last.transcriptPath)
          return reported === last.sessionId
            ? { state: 'same' }
            : reported
              ? { state: 'different', reported }
              : { state: 'unconfirmed' }
        }
      }
    }
  }

  providerRoot(provider: SessionHostRelocationProvider): string {
    return join(this.home, provider === 'claude' ? '.claude' : '.codex')
  }

  private transcripts = new Map<string, string>()

  adoptTranscriptsOf(other: TestComputer): void {
    for (const [key, path] of other.transcripts) {
      this.transcripts.set(key, path)
    }
  }

  transcriptOf(provider: { agent: string; sessionId: string }): string | null {
    return this.transcripts.get(`${provider.agent}:${provider.sessionId}`) ?? null
  }

  /** Writes a provider-native transcript here and adopts its conversation into this host's registry. */
  async conversation(
    provider: SessionHostRelocationProvider,
    sessionId: string,
    turns = 12
  ): Promise<SessionHostRegistration> {
    const path =
      provider === 'claude'
        ? join(
            this.providerRoot('claude'),
            'projects',
            encodeClaudeProjectPath(`/work/${this.name}`),
            `${sessionId}.jsonl`
          )
        : join(
            this.providerRoot('codex'),
            'sessions',
            '2026',
            '09',
            '26',
            `rollout-2026-09-26T08-00-00-${sessionId}.jsonl`
          )
    const records =
      provider === 'claude'
        ? Array.from({ length: turns }, (_, n) => ({
            type: n % 2 ? 'assistant' : 'user',
            n,
            sessionId
          }))
        : [
            { type: 'session_meta', payload: { id: sessionId } },
            ...Array.from({ length: turns }, (_, n) => ({ type: 'response_item', n }))
          ]
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    writeFileSync(
      join(this.providerRoot(provider), provider === 'claude' ? '.credentials.json' : 'auth.json'),
      '{"secret":"fake-credential-never-travels"}'
    )
    this.transcripts.set(`${provider}:${sessionId}`, path)
    const registered = await registerSessionHostConversation(this.service.store, {
      provider: { agent: provider, sessionId },
      binding: { worktreeId: `wt-${this.name}`, paneKey: `tab-${sessionId}:leaf-1`, kind: 'pty' },
      workspace: { kind: 'folder', path: `/work/${this.name}` },
      processIncarnation: 'pid-100',
      adopted: true
    })
    if (registered.status !== 'ok') {
      throw new Error(registered.refusal.message)
    }
    return registered.registration
  }
}

/** The id a provider would report: the one its own transcript records. */
export function transcriptIdentity(path: string): string | null {
  try {
    const first = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]!) as {
      sessionId?: string
      payload?: { id?: string }
    }
    return first.sessionId ?? first.payload?.id ?? null
  } catch {
    return null
  }
}
