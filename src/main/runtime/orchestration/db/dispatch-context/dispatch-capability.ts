import { randomBytes, timingSafeEqual } from 'node:crypto'
import { OrchestrationError } from '../../orchestration-error'
import { hashDispatchCapability } from '../dispatch-capability-hash'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

export function mintDispatchCapability(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    paneKey: string
    processIncarnation: string
  }
): string {
  const dispatch = this.getDispatchContextById(params.dispatchId)
  if (!dispatch || (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')) {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Dispatch ${params.dispatchId} is not active.`
    )
  }
  const capability = `dcap_${randomBytes(32).toString('base64url')}`
  this.db
    .prepare(
      `UPDATE dispatch_contexts
       SET capability_hash = ?, assignee_pane_key = ?, process_incarnation = ?,
           capability_revoked_at = NULL
       WHERE id = ?`
    )
    .run(
      hashDispatchCapability(capability),
      params.paneKey,
      params.processIncarnation,
      params.dispatchId
    )
  return capability
}

export function verifyDispatchCapability(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    capability: string | undefined
    paneKey: string | undefined
    processIncarnation: string | undefined
  }
): { valid: true } | { valid: false; reason: string } {
  const dispatch = this.getDispatchContextById(params.dispatchId)
  if (!dispatch) {
    return { valid: false, reason: `Dispatch ${params.dispatchId} was not found.` }
  }
  if (!dispatch.capability_hash) {
    return { valid: false, reason: `Dispatch ${params.dispatchId} has no lifecycle capability.` }
  }
  if (dispatch.capability_revoked_at) {
    // Why: a worker refused here has usually finished real work. Tell it what settled the Dispatch
    // and that nothing it sends will be recorded, so it saves the result instead of retrying.
    const settled =
      dispatch.status === 'failed' && dispatch.last_failure
        ? ` It was marked failed: ${dispatch.last_failure}`
        : ` It is ${dispatch.status}.`
    return {
      valid: false,
      reason:
        `Dispatch ${params.dispatchId} capability is revoked.${settled} This call was not ` +
        'recorded; save your result to a file and give its path to the person who started the work.'
    }
  }
  if (!params.capability) {
    // Why: a worker that omits the flag needs the flag name, not just the diagnosis.
    return {
      valid: false,
      reason:
        'The Dispatch capability is missing. Pass --dispatch-capability <token> from your dispatch preamble.'
    }
  }
  const expected = Buffer.from(dispatch.capability_hash, 'hex')
  const observed = Buffer.from(hashDispatchCapability(params.capability), 'hex')
  if (expected.length !== observed.length || !timingSafeEqual(expected, observed)) {
    return { valid: false, reason: 'The Dispatch capability is invalid.' }
  }
  if (
    !dispatch.assignee_pane_key ||
    !params.paneKey ||
    !isEquivalentPaneKey(dispatch.assignee_pane_key, params.paneKey)
  ) {
    return { valid: false, reason: 'The caller is not the Dispatch pane.' }
  }
  if (
    !dispatch.process_incarnation ||
    !params.processIncarnation ||
    dispatch.process_incarnation !== params.processIncarnation
  ) {
    return { valid: false, reason: 'The Dispatch process incarnation changed.' }
  }
  return { valid: true }
}

export function revokeDispatchCapability(this: OrchestrationDb, dispatchId: string): void {
  this.db
    .prepare(
      `UPDATE dispatch_contexts
       SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
       WHERE id = ?`
    )
    .run(dispatchId)
}

export type DispatchCapabilityMethods = {
  mintDispatchCapability: typeof mintDispatchCapability
  verifyDispatchCapability: typeof verifyDispatchCapability
  revokeDispatchCapability: typeof revokeDispatchCapability
}

export function attachDispatchCapability(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    mintDispatchCapability,
    verifyDispatchCapability,
    revokeDispatchCapability
  })
}
