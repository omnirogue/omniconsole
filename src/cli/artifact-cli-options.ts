import type { ArtifactCloudOperation, ArtifactCloudOptions } from '../shared/artifacts'
import type { HandlerContext } from './dispatch'
import { RuntimeClientError } from './runtime-client'

export function stringFlag(ctx: HandlerContext, name: string): string | undefined {
  const value = ctx.flags.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function requireStringFlag(ctx: HandlerContext, name: string): string {
  const value = stringFlag(ctx, name)
  if (!value) {
    throw new RuntimeClientError('invalid_argument', `Missing required ${name}.`)
  }
  return value
}

export function cloudOptions(ctx: HandlerContext): ArtifactCloudOptions {
  const apiUrl = stringFlag(ctx, 'api-url') ?? process.env.ORCA_ARTIFACTS_API_URL?.trim()
  const authToken = process.env.ORCA_CLOUD_AUTH_TOKEN?.trim()
  return {
    ...(apiUrl ? { apiUrl } : {}),
    ...(authToken ? { authToken } : {})
  }
}

export function rejectRemoteSelectionFlags(ctx: HandlerContext): void {
  for (const flag of ['environment', 'pairing-code']) {
    if (ctx.flags.has(flag)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `\`--${flag}\` does not retarget artifact commands; artifacts use the signed-in desktop account.`
      )
    }
  }
}

export function requireOperation<T>(operation: ArtifactCloudOperation<T>): T {
  if (operation.status === 'ok') {
    return operation.value
  }
  if (operation.status === 'reconnect-required') {
    throw new RuntimeClientError('authentication_required', 'Sign in to OmniConsole and try again.')
  }
  throw new RuntimeClientError('authentication_unconfigured', operation.message)
}
