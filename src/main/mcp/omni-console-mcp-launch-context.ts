import { AsyncLocalStorage } from 'node:async_hooks'
import { isOmniConsoleMcpSignedIn } from './omni-console-mcp-auth'

type LaunchDefaultsScope = { requested: boolean; active: boolean }
const launchDefaults = new AsyncLocalStorage<LaunchDefaultsScope>()

/** Carries a public endpoint default only during one authenticated RPC invocation. */
export async function withOmniConsoleMcpLaunchDefaults<T>(
  requested: boolean,
  invoke: () => T | Promise<T>
): Promise<T> {
  const scope = { requested, active: true }
  return launchDefaults.run(scope, async () => {
    try {
      return await invoke()
    } finally {
      // Detached work must not inherit eligibility after the request has settled.
      scope.active = false
    }
  })
}

export function isOmniConsoleMcpDefaultRequested(userDataPath?: string): boolean {
  const scope = launchDefaults.getStore()
  return (scope?.active === true && scope.requested) || isOmniConsoleMcpSignedIn(userDataPath)
}
