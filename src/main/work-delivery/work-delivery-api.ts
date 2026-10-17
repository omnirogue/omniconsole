/**
 * The desktop's calls to OmniOS's work-delivery routes (bff/omni_bff/work_delivery.py). Every
 * answer is ok, refused with OmniOS's code (409 claimed, not_lease_holder, already_respawned…),
 * unsupported (today's OmniOS lacks the routes) or failed.
 */

import type { ArtifactCloudService } from '../artifacts/artifact-cloud-service'
import { artifactApiRequest } from '../artifacts/artifact-cloud-request'
import { wakeCopyApiResult, type WakeCopyApiResult } from '../artifacts/review-wake-copy-api'
import type {
  ClaimableDelivery,
  WorkDeliveryHeldReason,
  WorkDeliveryKind,
  WorkDeliveryOwner,
  WorkDeliveryStep
} from './work-delivery-kind'

export type WorkDeliveryApiResult<T> = WakeCopyApiResult<T>

export type WorkDeliveryReceipt = {
  state: 'claimed' | 'typed' | 'working' | 'done' | 'held' | 'released'
  step?: WorkDeliveryStep
  heldReason?: WorkDeliveryHeldReason
  detail?: Record<string, unknown>
  revived?: string
  respawnedRef?: string
  owner?: Partial<WorkDeliveryOwner>
}

export type WorkOwnerBinding = Partial<WorkDeliveryOwner> & {
  hostId: string
  source: string
  deliverVia?: 'desktop' | 'routine'
  routineRef?: string
  prNumbers?: number[]
  since?: string
}

export type WorkDeliveryApi = {
  claimable(
    hostId: string,
    hostLabel: string,
    caps: readonly WorkDeliveryKind[]
  ): Promise<WorkDeliveryApiResult<ClaimableDelivery[]>>
  claim(
    key: string,
    hostId: string,
    hostLabel: string
  ): Promise<WorkDeliveryApiResult<ClaimableDelivery>>
  receipt(
    key: string,
    hostId: string,
    receipt: WorkDeliveryReceipt
  ): Promise<WorkDeliveryApiResult<unknown>>
  bindOwner(workItem: string, binding: WorkOwnerBinding): Promise<WorkDeliveryApiResult<unknown>>
  sessionState(
    workItem: string,
    hostId: string,
    state: 'running' | 'archived' | 'exited' | 'gone' | 'deleted'
  ): Promise<WorkDeliveryApiResult<unknown>>
}

export const WORK_DELIVERY_LEASE_S = 300

type Send = <T>(
  path: string,
  options?: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown }
) => Promise<WorkDeliveryApiResult<T>>

export function workDeliveryApi(service: Pick<ArtifactCloudService, 'signedIn'>): WorkDeliveryApi {
  const send: Send = async <T>(
    path: string,
    options: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {}
  ) => {
    try {
      const sent = await service.signedIn((token, apiUrl) =>
        artifactApiRequest<T>(apiUrl, token, path, options)
      )
      return sent.status === 'ok' ? { status: 'ok', value: sent.value } : { status: 'failed' }
    } catch (error) {
      return wakeCopyApiResult(error)
    }
  }
  return workDeliveryApiOver(send)
}

export function workDeliveryApiOver(send: Send): WorkDeliveryApi {
  const item = (workItem: string) => encodeURIComponent(workItem)
  return {
    claimable: async (hostId, hostLabel, caps) => {
      const query = new URLSearchParams({
        host_id: hostId,
        host_label: hostLabel,
        caps: caps.join(',')
      })
      const read = await send<{ deliveries: ClaimableDelivery[] }>(
        `/v1/work-deliveries/claimable?${query}`
      )
      return read.status === 'ok' ? { status: 'ok', value: read.value.deliveries ?? [] } : read
    },
    claim: async (key, hostId, hostLabel) => {
      const claimed = await send<{ delivery: ClaimableDelivery }>(
        `/v1/work-deliveries/${encodeURIComponent(key)}/claim`,
        {
          method: 'POST',
          body: { host_id: hostId, host_label: hostLabel, lease_s: WORK_DELIVERY_LEASE_S }
        }
      )
      return claimed.status === 'ok' ? { status: 'ok', value: claimed.value.delivery } : claimed
    },
    receipt: (key, hostId, receipt) =>
      send(`/v1/work-deliveries/${encodeURIComponent(key)}/receipt`, {
        method: 'POST',
        body: {
          host_id: hostId,
          state: receipt.state,
          ...(receipt.step ? { step: receipt.step } : {}),
          ...(receipt.heldReason ? { held_reason: receipt.heldReason } : {}),
          ...(receipt.detail ? { detail: receipt.detail } : {}),
          ...(receipt.revived ? { revived: receipt.revived } : {}),
          ...(receipt.respawnedRef ? { respawned_ref: receipt.respawnedRef } : {}),
          ...(receipt.owner ? { owner: receipt.owner } : {})
        }
      }),
    bindOwner: (workItem, binding) =>
      send(`/v1/work-items/${item(workItem)}/owner`, { method: 'PUT', body: binding }),
    sessionState: (workItem, hostId, state) =>
      send(`/v1/work-items/${item(workItem)}/state`, { method: 'POST', body: { hostId, state } })
  }
}
