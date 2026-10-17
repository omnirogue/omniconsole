/**
 * Relocation's steps on the destination: prepare (a place it can run: provider version, workspace,
 * account), stage (import the verified bundle, launch nothing) and resume once (consume the grant
 * durably, resume exactly the staged identity, and accept work only after the provider itself
 * reports that identity). The destination never falls back to a fresh or different conversation.
 */

import type { SessionHostPayloads } from '../../shared/session-host-payload-schema'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import type {
  SessionHostExecutionInput,
  SessionHostPrepared
} from '../session-host/session-host-executor'
import type { SessionHostSettlement } from '../session-host/session-host-settlement'
import {
  consumeSessionHostGrant,
  registerSessionHostConversation
} from '../session-host/session-host-ownership-registry'
import {
  relocationFileDigest,
  SessionRelocationRefusal
} from '../session-relocation/relocation-bundle-files'
import { importRelocationBundle } from '../session-relocation/relocation-bundle-import'
import { compareProviderVersions } from '../session-relocation/relocation-provider-adapter'
import type { SessionTransferHostActionDeps } from './session-transfer-host-action-deps'
import { refuseStep, relocationGate } from './session-transfer-relocate-source'
import {
  readRelocationPlace,
  readRelocationStaged,
  relocationStagingDir,
  writeRelocationPlace,
  writeRelocationStaged
} from './session-transfer-relocation-records'

export async function prepareRelocationDestination(
  deps: SessionTransferHostActionDeps,
  input: SessionHostExecutionInput
): Promise<SessionHostPrepared> {
  const { request } = input
  const payload = request.payload as SessionHostPayloads['relocate.prepare-destination']
  const gate = relocationGate(deps, payload.provider)
  if (gate) {
    return gate
  }
  if (
    payload.source.conversationId !== request.conversationId ||
    request.expectedOwnerEpoch !== payload.source.ownerEpoch + 1 ||
    payload.source.hostId === deps.store.host.hostId
  ) {
    return refuseStep(
      'invalid-request',
      'The move names another conversation, a stale owner epoch or this computer as its source. Nothing was changed.'
    )
  }
  const check = await deps.relocationDestination!.check(payload)
  if (!check.ok) {
    return { kind: 'refuse', refusal: check.refusal }
  }
  // Why also checked again at staging: there the transcript itself says which version wrote it.
  if ((compareProviderVersions(payload.providerVersion, check.providerVersion) ?? 0) > 0) {
    return refuseStep(
      'not-eligible',
      `That computer has ${payload.provider} ${check.providerVersion}, older than ${payload.providerVersion} on the source, which may not read the conversation. Nothing was changed.`
    )
  }
  return {
    kind: 'dispatch',
    dispatch: async () => {
      writeRelocationPlace(deps.store, {
        relocation: payload.relocation,
        conversationId: request.conversationId,
        provider: payload.provider,
        sourceHostId: payload.source.hostId,
        ownerEpoch: request.expectedOwnerEpoch,
        providerRoot: check.providerRoot,
        workspace: check.workspace,
        providerVersion: check.providerVersion,
        at: deps.store.now()
      })
      return {
        kind: 'completed',
        result: {
          relocation: payload.relocation,
          prepared: true,
          stagingDir: relocationStagingDir(deps.store, payload.relocation),
          workspacePath: check.workspace.path,
          providerVersion: check.providerVersion
        }
      }
    }
  }
}

function refused(error: unknown): SessionHostSettlement {
  return {
    kind: 'not-delivered',
    refusal:
      error instanceof SessionRelocationRefusal
        ? error.refusal
        : sessionHostRefusal(
            'not-eligible',
            `${error instanceof Error ? error.message : String(error)} Nothing was staged.`
          )
  }
}

export async function prepareRelocationStage(
  deps: SessionTransferHostActionDeps,
  input: SessionHostExecutionInput
): Promise<SessionHostPrepared> {
  const { request } = input
  const payload = request.payload as SessionHostPayloads['relocate.stage']
  const gate = relocationGate(deps, payload.provider)
  if (gate) {
    return gate
  }
  const place = readRelocationPlace(deps.store, payload.relocation)
  if (
    !place ||
    place.conversationId !== request.conversationId ||
    place.provider !== payload.provider ||
    payload.manifest.provider !== payload.provider
  ) {
    return refuseStep(
      'not-eligible',
      'This computer was not prepared for that move. Nothing was staged.'
    )
  }
  return {
    kind: 'dispatch',
    dispatch: async () => {
      try {
        const staged = await importRelocationBundle({
          stagingRoot: relocationStagingDir(deps.store, payload.relocation),
          manifest: payload.manifest,
          place: { providerRoot: place.providerRoot, workspacePath: place.workspace.path },
          providerVersion: place.providerVersion
        })
        writeRelocationStaged(deps.store, {
          relocation: payload.relocation,
          manifestDigest: payload.manifest.digest,
          manifest: payload.manifest,
          files: staged.plan.files,
          identity: staged.identity,
          at: deps.store.now()
        })
        return {
          kind: 'completed',
          result: {
            relocation: payload.relocation,
            ready: true,
            manifestDigest: payload.manifest.digest,
            providerSessionId: staged.identity.sessionId
          }
        }
      } catch (error) {
        return refused(error)
      }
    }
  }
}

export async function prepareRelocationResume(
  deps: SessionTransferHostActionDeps,
  input: SessionHostExecutionInput
): Promise<SessionHostPrepared> {
  const { request, operation } = input
  const payload = request.payload as SessionHostPayloads['relocate.resume']
  const gate = relocationGate(deps, payload.provider)
  if (gate) {
    return gate
  }
  const { grant } = payload
  const staged = readRelocationStaged(deps.store, payload.relocation)
  const place = readRelocationPlace(deps.store, payload.relocation)
  if (
    grant.toHostId !== deps.store.host.hostId ||
    grant.conversationId !== request.conversationId ||
    grant.ownerEpoch !== request.expectedOwnerEpoch ||
    grant.relocation !== payload.relocation ||
    grant.provider.agent !== payload.provider
  ) {
    return refuseStep(
      'grant-invalid',
      'That grant is for another computer, conversation or move. Nothing was changed.'
    )
  }
  if (
    !staged ||
    !place ||
    staged.manifestDigest !== grant.manifestDigest ||
    staged.identity.sessionId !== grant.provider.sessionId
  ) {
    return refuseStep(
      'not-eligible',
      'This computer has not staged the bundle that grant names, so it does not take the conversation. Nothing was changed.'
    )
  }
  const destination = deps.relocationDestination!
  return {
    kind: 'dispatch',
    dispatch: async () => {
      // Why re-read before consuming: the grant is single-use, so the files must still be whole.
      const expected = new Map(staged.manifest.files.map((file) => [file.path, file]))
      for (const file of staged.files) {
        const landed = await relocationFileDigest(file.absolute, file.path).catch(() => null)
        if (!landed || landed.sha256 !== expected.get(file.path)?.sha256) {
          return refused(
            new Error(`${file.path} changed on this computer after it was staged; stage it again.`)
          )
        }
      }
      const consumed = await consumeSessionHostGrant(
        deps.store,
        grant,
        { binding: null, workspace: place.workspace, processIncarnation: null },
        operation.operationId
      )
      if (consumed.status !== 'ok') {
        return { kind: 'not-delivered', refusal: consumed.refusal }
      }
      const owned = (reason: string, extra: Record<string, unknown> = {}) => ({
        kind: 'completed' as const,
        result: { relocation: payload.relocation, resumed: false, owned: true, reason, ...extra }
      })
      let launched: Awaited<ReturnType<typeof destination.launch>>
      try {
        launched = await destination.launch({
          identity: staged.identity,
          workspace: place.workspace,
          conversationId: request.conversationId,
          operationId: operation.operationId
        })
      } catch (error) {
        return owned(
          `This computer owns it now, but starting it failed (${error instanceof Error ? error.message : String(error)}). Resume it here; it never goes back to the source by itself.`
        )
      }
      const confirmed = await destination
        .confirm(launched.binding)
        .catch(() => ({ state: 'unconfirmed' as const }))
      if (confirmed.state !== 'same') {
        return owned(
          confirmed.state === 'different'
            ? `The provider opened a different conversation (${confirmed.reported}); nothing is delivered to it until a person checks.`
            : 'The provider did not report which conversation it opened; nothing is delivered to it until a person checks.',
          { binding: launched.binding }
        )
      }
      await registerSessionHostConversation(deps.store, {
        provider: grant.provider,
        binding: launched.binding,
        workspace: place.workspace,
        processIncarnation: launched.processIncarnation,
        adopted: true
      })
      return {
        kind: 'completed',
        result: {
          relocation: payload.relocation,
          resumed: true,
          ownerEpoch: grant.ownerEpoch,
          providerSessionId: grant.provider.sessionId,
          binding: launched.binding
        }
      }
    }
  }
}
