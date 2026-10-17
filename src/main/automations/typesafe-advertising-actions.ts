import { verbFor, assertPreview, assertReceipt } from './typesafe-advertising-native-binding'
import {
  advertisingDecisionEnvelope,
  advertisingRoutinePolicy
} from '../../shared/typesafe-advertising'
import type {
  TypedAdvertisingActionPreview,
  TypedAdvertisingActionReceipt
} from '../../shared/advertising-action-provider-contract'
import {
  prepareAdvertisingAction,
  sendAdvertisingAction,
  verifyAdvertisingAction,
  type AdvertisingActionContext
} from './advertising-action-provider'
import {
  assertLocalMetaActionAuthorized,
  type LocalMetaActionScope
} from './local-meta-action-authority'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import {
  advertisingDigest,
  advertisingEvidenceRevision,
  assertAdvertisingEvidenceFresh,
  fetchAdvertisingEvidence
} from './typesafe-advertising-evidence'

import {
  loadAdvertisingSelectionBinding,
  assertAdvertisingObjectSendAvailable,
  withAdvertisingSelectionObjectLock,
  type AdvertisingActionSelection,
  type AdvertisingActionBinding,
  type AdvertisingActionStore
} from './advertising-action-store'
export type {
  AdvertisingActionSelection,
  AdvertisingActionBinding,
  AdvertisingActionStore
} from './advertising-action-store'

/** Only the owner stores bindings; renderer input names an already persisted decision. */
export class TypesafeAdvertisingActionService {
  private readonly pending = new Map<string, Promise<unknown>>()
  constructor(private readonly store: AdvertisingActionStore) {}

  private serial<T>(selection: AdvertisingActionSelection, work: () => Promise<T>): Promise<T> {
    const key = selection.decisionId
    const prior = this.pending.get(key) ?? Promise.resolve()
    const scoped = () => withAdvertisingSelectionObjectLock(this.store, selection, work)
    const result = prior
      .catch(() => undefined)
      .then(() =>
        this.store.withRunLock
          ? this.store.withRunLock(selection.automationId, selection.runId, scoped)
          : scoped()
      )
    this.pending.set(key, result)
    void result
      .finally(() => {
        if (this.pending.get(key) === result) {
          this.pending.delete(key)
        }
      })
      .catch(() => undefined)
    return result
  }

  private async decision(
    selection: AdvertisingActionSelection,
    refresh: boolean,
    verificationOnly = false,
    assertOwnerCurrent: () => void = () => undefined
  ) {
    const parsed = advertisingDecisionEnvelope.safeParse(
      await this.store.loadEnvelope(selection.automationId, selection.runId, { verificationOnly })
    )
    const policy = advertisingRoutinePolicy.safeParse(
      verificationOnly && parsed.success
        ? parsed.data.policy
        : await this.store.loadPolicy(selection.automationId)
    )
    if (
      !policy.success ||
      !parsed.success ||
      parsed.data.status !== 'ready' ||
      parsed.data.routineId !== selection.automationId ||
      parsed.data.runId !== selection.runId ||
      advertisingDigest(policy.data) !== advertisingDigest(parsed.data.policy)
    ) {
      throw new Error('The routine policy or its validated advertising decision is unavailable.')
    }
    const envelope = parsed.data
    const decision = envelope.decisions.find((item) => item.id === selection.decisionId)
    if (
      !decision ||
      (decision.recommendationOnly && decision.evidence.source !== 'local.meta.graph') ||
      !decision.requiresHumanApproval ||
      decision.confidence < policy.data.minConfidence
    ) {
      throw new Error('This advertising decision is not eligible for a status action.')
    }
    verbFor(decision)
    const captured = await captureConsoleWorkflowPerson()
    if (!captured.ok || captured.data.principal !== envelope.principal) {
      throw new Error('Sign in as the person whose source evidence produced this recommendation.')
    }
    let scope: LocalMetaActionScope | undefined
    if (decision.evidence.source === 'local.meta.graph') {
      if (
        !this.store.captureLocalScope ||
        !this.store.withObjectLock ||
        !this.store.loadObjectAction
      ) {
        throw new Error('The separate local advertising action authority is unavailable.')
      }
      const owner = this.store.captureLocalScope(
        selection.automationId,
        selection.runId,
        verificationOnly
      )
      scope = {
        ...owner,
        target: decision.target,
        isCurrent: () => {
          assertOwnerCurrent()
          return captured.data.isCurrent() && owner.isCurrent()
        }
      }
      await assertLocalMetaActionAuthorized(scope, policy.data, captured.data.principal)
    }
    if (refresh) {
      assertAdvertisingEvidenceFresh(decision.evidence, policy.data)
      const [current] = await fetchAdvertisingEvidence(
        [decision.target],
        policy.data,
        undefined,
        scope
      )
      if (
        !captured.data.isCurrent() ||
        advertisingEvidenceRevision(current) !== decision.evidenceRevision
      ) {
        throw new Error('Advertising evidence changed; refresh the recommendation before acting.')
      }
    }
    const assertCurrent = async () => {
      await scope?.assertCurrent?.()
      assertOwnerCurrent()
      if (!captured.data.isCurrent() || (scope && !scope.isCurrent())) {
        throw new Error('The advertising principal or execution authority changed.')
      }
    }
    return { decision, envelope, principal: captured.data.principal, scope, assertCurrent }
  }

  private async binding(
    selection: AdvertisingActionSelection,
    verificationOnly = false,
    assertOwnerCurrent: () => void = () => undefined
  ) {
    const context = await this.decision(selection, false, verificationOnly, assertOwnerCurrent)
    const { decision, envelope, principal } = context
    const binding = await loadAdvertisingSelectionBinding(this.store, selection)
    if (
      !binding ||
      binding.automationId !== selection.automationId ||
      binding.runId !== selection.runId ||
      binding.decisionId !== selection.decisionId ||
      binding.sourceRevision !== envelope.sourceRevision ||
      binding.principal !== principal
    ) {
      throw new Error('The reviewed native action is unavailable for this decision.')
    }
    assertPreview(binding.preview, decision)
    if (
      (binding.preview.protocol_version === 'local-human-action.v1') !==
      (decision.evidence.source === 'local.meta.graph')
    ) {
      throw new Error('The recorded advertising action belongs to a different authority provider.')
    }
    return { binding, ...context }
  }

  preview(
    selection: AdvertisingActionSelection,
    assertOwnerCurrent: () => void = () => undefined
  ): Promise<{ preview: TypedAdvertisingActionPreview }> {
    return this.serial(selection, async () => {
      const prior = await loadAdvertisingSelectionBinding(this.store, selection)
      if (prior?.submitted) {
        return {
          preview: (await this.binding(selection, true, assertOwnerCurrent)).binding.preview
        }
      }
      const context = await this.decision(selection, true, false, assertOwnerCurrent)
      const { decision, envelope, principal } = context
      if (prior) {
        const checked = await this.binding(selection, false, assertOwnerCurrent)
        if (
          checked.binding.submitted ||
          Date.parse(checked.binding.preview.expires_at) > Date.now()
        ) {
          return { preview: checked.binding.preview }
        }
      }
      await this.decision(selection, false)
      assertOwnerCurrent()
      const preview = await prepareAdvertisingAction(context)
      assertPreview(preview, decision)
      await this.decision(selection, false)
      assertOwnerCurrent()
      await this.store.saveAction({
        automationId: selection.automationId,
        runId: selection.runId,
        decisionId: selection.decisionId,
        principal,
        sourceRevision: envelope.sourceRevision,
        idempotencyKey: `tsa:${decision.id}`,
        preview,
        submitted: false,
        receipt: null
      })
      return { preview }
    })
  }

  execute(
    selection: AdvertisingActionSelection & {
      previewId: string
      expectedRevision: string
      approved: boolean
    },
    assertOwnerCurrent: () => void = () => undefined
  ): Promise<{ receipt: TypedAdvertisingActionReceipt }> {
    return this.serial(selection, async () => {
      if (selection.approved !== true) {
        throw new Error('Confirm this exact advertising action before execution.')
      }
      const context = await this.binding(selection, false, assertOwnerCurrent)
      const { binding, decision } = context
      if (
        binding.preview.id !== selection.previewId ||
        binding.preview.revision !== selection.expectedRevision
      ) {
        throw new Error('The approval names a different native advertising preview.')
      }
      if (binding.submitted) {
        return this.verifySaved(binding, context, assertOwnerCurrent)
      }
      await assertAdvertisingObjectSendAvailable(this.store, binding)
      await this.decision(selection, true)
      if (Date.parse(binding.preview.expires_at) <= Date.now()) {
        throw new Error('The native preview expired; review a new preview.')
      }
      await this.decision(selection, false)
      assertOwnerCurrent()
      binding.submitted = true
      if (binding.preview.protocol_version === 'local-human-action.v1') {
        binding.submittedAt = new Date().toISOString()
      }
      await this.store.saveAction(binding)
      await this.decision(selection, false)
      assertOwnerCurrent()
      const receipt = await sendAdvertisingAction(context, binding)
      assertReceipt(receipt, binding, decision)
      binding.receipt = receipt
      await this.store.saveAction(binding)
      return { receipt }
    })
  }

  private async verifySaved(
    binding: AdvertisingActionBinding,
    context: AdvertisingActionContext,
    assertOwnerCurrent: () => void
  ) {
    assertOwnerCurrent()
    const receipt = await verifyAdvertisingAction(context, binding)
    assertReceipt(receipt, binding, context.decision)
    binding.receipt = receipt
    await this.store.saveAction(binding)
    return { receipt }
  }

  verify(
    selection: AdvertisingActionSelection,
    assertOwnerCurrent: () => void = () => undefined
  ): Promise<{ receipt: TypedAdvertisingActionReceipt }> {
    return this.serial(selection, async () => {
      const context = await this.binding(selection, true, assertOwnerCurrent)
      const { binding } = context
      if (!binding.submitted) {
        throw new Error('This preview has no recorded advertising send to verify.')
      }
      return this.verifySaved(binding, context, assertOwnerCurrent)
    })
  }
}
