import { isOmniConsoleMcpLaunchMethod } from '../../../shared/omni-console-mcp-launch-defaults'
import { withOmniConsoleMcpLaunchDefaults } from '../../mcp/omni-console-mcp-launch-context'
import type { RpcRequest } from './core'

export function omniConsoleMcpRequestError(request: RpcRequest): string | undefined {
  if (request.omniConsoleMcpDefault === undefined) {
    return undefined
  }
  if (request.omniConsoleMcpDefault !== true || !isOmniConsoleMcpLaunchMethod(request.method)) {
    return 'omniConsoleMcpDefault must be true on a supported agent launch request.'
  }
  return undefined
}

export function invokeWithOmniConsoleMcpDefaults<T>(
  request: RpcRequest,
  invoke: () => T | Promise<T>
): Promise<T> {
  return withOmniConsoleMcpLaunchDefaults(request.omniConsoleMcpDefault === true, invoke)
}
