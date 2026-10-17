import { workspaceFileDeliveryRequest } from '../../../../shared/workspace-file-delivery'
import { defineMethod, type RpcAnyMethod } from '../core'

export const FILE_DELIVERY_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'files.deliver',
    params: workspaceFileDeliveryRequest,
    handler: (params, { runtime, signal }) => runtime.deliverWorkspaceFile(params, signal)
  })
]
