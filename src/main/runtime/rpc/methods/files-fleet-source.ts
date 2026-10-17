import {
  captureFleetSourceRequest,
  captureFleetSourceResult,
  readFleetSourceChunkRequest,
  releaseFleetSourceRequest
} from '../../../../shared/conversation-fleet-source-snapshot'
import { remoteRpcResultExceedsContentBudget } from '../../../../shared/remote-rpc-content-budget'
import { FleetSourceSnapshotCache } from '../../conversation-fleet-source-cache'
import { defineMethod, type RpcAnyMethod, type RpcContext } from '../core'
import { remoteFileContentBudget } from './files-remote-content-budget'

const caches = new WeakMap<object, FleetSourceSnapshotCache>()

function cache(context: RpcContext): FleetSourceSnapshotCache {
  let result = caches.get(context.runtime)
  if (!result) {
    result = new FleetSourceSnapshotCache()
    caches.set(context.runtime, result)
  }
  return result
}

function owner(context: RpcContext): string {
  const identity =
    context.authenticatedCallerFingerprint ??
    context.pairedDeviceId ??
    context.clientId ??
    context.connectionId
  if (!identity && context.clientKind) {
    throw new Error('An authenticated client identity is required to capture source files.')
  }
  return identity ? `${context.clientKind ?? 'local'}:${identity}` : 'in-process'
}

function withinBudget<T>(result: T, context: RpcContext): T {
  const budget = remoteFileContentBudget(context.clientKind, context.requestId)
  if (budget !== undefined && remoteRpcResultExceedsContentBudget(result, budget)) {
    throw new Error('The source snapshot reply exceeds this connection’s transport limit.')
  }
  return result
}

export const FILE_FLEET_SOURCE_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'files.captureFleetSource',
    params: captureFleetSourceRequest,
    handler: async (params, context) => {
      const snapshot = await cache(context).capture(owner(context), async () => {
        const captured = await context.runtime.captureFleetSourceSnapshot(params, context.signal)
        captureFleetSourceResult.parse(captured.manifest)
        withinBudget(captured.manifest, context)
        return captured
      })
      return snapshot
    }
  }),
  defineMethod({
    name: 'files.readFleetSourceChunk',
    params: readFleetSourceChunkRequest,
    handler: (params, context) => withinBudget(cache(context).read(owner(context), params), context)
  }),
  defineMethod({
    name: 'files.releaseFleetSource',
    params: releaseFleetSourceRequest,
    handler: (params, context) => cache(context).release(owner(context), params.snapshotId)
  })
]
