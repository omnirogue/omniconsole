/**
 * Relocation's steps on the host that runs the conversation: freeze (every driver suspended, the
 * provider stopped with positive exit evidence), export (a checksummed snapshot of its native
 * files), and relinquish (one durable step: stop owning it and grant it to exactly one destination
 * at the next epoch). Freeze and export keep the reservation; only relinquish ends it. After
 * relinquishment nothing here ever runs the conversation again, whatever happens to replies.
 */

import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  SessionHostPayloads,
  SessionHostRelocationManifest
} from '../../shared/session-host-payload-schema'
import type { SessionHostRelocationProvider } from '../../shared/session-host-capabilities'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import type {
  SessionHostExecutionInput,
  SessionHostPrepared
} from '../session-host/session-host-executor'
import type {
  SessionHostJournal,
  SessionHostJournalOperation,
  SessionHostRegistration
} from '../session-host/session-host-journal'
import { relinquishSessionHostConversation } from '../session-host/session-host-ownership-registry'
import {
  SessionRelocationRefusal,
  verifyRelocationBundle
} from '../session-relocation/relocation-bundle-files'
import {
  exportRelocationBundle,
  RELOCATION_PROVIDER_ADAPTERS
} from '../session-relocation/relocation-bundle-import'
import type { SessionTransferHostActionDeps } from './session-transfer-host-action-deps'
import { relocationExportDir } from './session-transfer-relocation-records'

type RelocationPayload = { relocation: string; provider: SessionHostRelocationProvider }

export const refuseStep = (
  code: SessionHostRefusal['code'],
  message: string
): SessionHostPrepared => ({ kind: 'refuse', refusal: sessionHostRefusal(code, message) })

/** Off switch, provider support and both halves of this host present; null when relocation may run. */
export function relocationGate(
  deps: SessionTransferHostActionDeps,
  provider: SessionHostRelocationProvider
): SessionHostPrepared | null {
  if (!deps.relocationEnabled()) {
    return refuseStep(
      'relocation-disabled',
      'Moving conversations is turned off on that computer. Nothing was changed.'
    )
  }
  if (
    !RELOCATION_PROVIDER_ADAPTERS[provider] ||
    !deps.relocationProviders().includes(provider) ||
    !deps.relocationSource ||
    !deps.relocationDestination
  ) {
    return refuseStep(
      'unsupported-capability',
      `That computer cannot move ${provider} conversations. Nothing was changed.`
    )
  }
  return null
}

/** The completed step of this relocation on this conversation, newest first. */
export function completedRelocationStep(
  journal: SessionHostJournal | null,
  conversationId: string,
  action: 'relocate.freeze-source' | 'relocate.export' | 'relocate.relinquish',
  relocation: string
): SessionHostJournalOperation | null {
  return (
    Object.values(journal?.operations ?? {})
      .filter(
        (operation) =>
          operation.action === action &&
          operation.conversationId === conversationId &&
          operation.state === 'completed' &&
          (operation.result as { relocation?: unknown } | undefined)?.relocation === relocation
      )
      .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))[0] ?? null
  )
}

function sourceGate(
  deps: SessionTransferHostActionDeps,
  input: SessionHostExecutionInput
): { payload: RelocationPayload; registration: SessionHostRegistration } | SessionHostPrepared {
  const payload = input.request.payload as RelocationPayload
  const gate = relocationGate(deps, payload.provider)
  if (gate) {
    return gate
  }
  if (!input.registration) {
    return refuseStep(
      'unknown-conversation',
      'That computer has no such conversation. Nothing was changed.'
    )
  }
  if (input.registration.provider.agent !== payload.provider) {
    return refuseStep(
      'invalid-request',
      `That conversation runs ${input.registration.provider.agent}, not ${payload.provider}. Nothing was changed.`
    )
  }
  return { payload, registration: input.registration }
}

export async function prepareRelocationFreeze(
  deps: SessionTransferHostActionDeps,
  input: SessionHostExecutionInput
): Promise<SessionHostPrepared> {
  const gated = sourceGate(deps, input)
  if ('kind' in gated) {
    return gated
  }
  const payload = input.request.payload as SessionHostPayloads['relocate.freeze-source']
  if (payload.destination.hostId === deps.store.host.hostId) {
    return refuseStep(
      'invalid-request',
      'A conversation cannot move to the computer that runs it. Nothing was changed.'
    )
  }
  const step = {
    registration: gated.registration,
    operationId: input.operation.operationId,
    authority: input.authority
  }
  return {
    kind: 'dispatch',
    dispatch: async () => {
      const evidence = await deps.relocationSource!.freeze(step).catch((error: unknown) => ({
        stopped: false as const,
        reason: error instanceof Error ? error.message : String(error)
      }))
      return {
        kind: 'completed',
        result: { relocation: payload.relocation, frozen: evidence.stopped, ...evidence }
      }
    }
  }
}

export async function prepareRelocationExport(
  deps: SessionTransferHostActionDeps,
  input: SessionHostExecutionInput
): Promise<SessionHostPrepared> {
  const gated = sourceGate(deps, input)
  if ('kind' in gated) {
    return gated
  }
  const { payload, registration } = gated
  const frozen = completedRelocationStep(
    deps.store.snapshot(),
    registration.conversationId,
    'relocate.freeze-source',
    payload.relocation
  )
  if ((frozen?.result as { frozen?: unknown } | undefined)?.frozen !== true) {
    return refuseStep(
      'not-eligible',
      'The conversation was not frozen for this move, so nothing was exported.'
    )
  }
  const source = deps.relocationSource!
  return {
    kind: 'dispatch',
    dispatch: async () => {
      const fail = (reason: string) => ({
        kind: 'completed' as const,
        result: { relocation: payload.relocation, exported: false, reason }
      })
      const evidence = await source.exitEvidence(registration)
      if (!evidence.stopped) {
        return fail(`It is no longer provably stopped (${evidence.reason}).`)
      }
      const transcriptPath = await source.transcriptPath(registration)
      if (!transcriptPath) {
        return fail('Its transcript was not found on that computer.')
      }
      const dir = relocationExportDir(deps.store, payload.relocation)
      try {
        const bundle = await exportRelocationBundle(payload.provider, {
          sessionId: registration.provider.sessionId,
          transcriptPath
        })
        rmSync(dir, { recursive: true, force: true })
        for (const [path, absolute] of bundle.files) {
          const to = join(dir, ...path.split('/'))
          mkdirSync(dirname(to), { recursive: true })
          cpSync(absolute, to, { errorOnExist: true, force: false })
        }
        // Why re-verify the snapshot: it is what travels, so it must equal what the manifest says.
        await verifyRelocationBundle(dir, bundle.manifest)
        return {
          kind: 'completed',
          result: {
            relocation: payload.relocation,
            exported: true,
            manifest: bundle.manifest,
            exportDir: dir
          }
        }
      } catch (error) {
        return fail(
          error instanceof SessionRelocationRefusal
            ? error.refusal.message
            : error instanceof Error
              ? error.message
              : String(error)
        )
      }
    }
  }
}

export async function prepareRelocationRelinquish(
  deps: SessionTransferHostActionDeps,
  input: SessionHostExecutionInput
): Promise<SessionHostPrepared> {
  const gated = sourceGate(deps, input)
  if ('kind' in gated) {
    return gated
  }
  const { registration } = gated
  const payload = input.request.payload as SessionHostPayloads['relocate.relinquish']
  const exported = completedRelocationStep(
    deps.store.snapshot(),
    registration.conversationId,
    'relocate.export',
    payload.relocation
  )
  const manifest = (exported?.result as { manifest?: SessionHostRelocationManifest } | undefined)
    ?.manifest
  if (!manifest || manifest.digest !== payload.manifestDigest) {
    return refuseStep(
      'not-eligible',
      'That is not the bundle this conversation exported for the move. Nothing was changed.'
    )
  }
  const source = deps.relocationSource!
  const operationId = input.operation.operationId
  return {
    kind: 'dispatch',
    dispatch: async () => {
      const keep = (reason: string) => ({
        kind: 'completed' as const,
        result: { relocation: payload.relocation, relinquished: false, reason },
        reservation: 'keep' as const
      })
      const evidence = await source.exitEvidence(registration)
      if (!evidence.stopped) {
        return keep(`It is no longer provably stopped (${evidence.reason}).`)
      }
      const relinquished = await relinquishSessionHostConversation(deps.store, {
        conversationId: registration.conversationId,
        grantId: operationId,
        relocation: payload.relocation,
        toHostId: payload.destination.hostId,
        manifestDigest: payload.manifestDigest
      })
      if (relinquished.status !== 'ok') {
        return keep(relinquished.refusal.message)
      }
      // Why after, and never undone: the durable tombstone already refuses every action here.
      const retired = await source
        .retire({ registration, operationId, authority: input.authority })
        .then(
          () => true,
          () => false
        )
      return {
        kind: 'completed',
        result: {
          relocation: payload.relocation,
          relinquished: true,
          grant: relinquished.grant,
          retired
        },
        reservation: 'settle'
      }
    }
  }
}
