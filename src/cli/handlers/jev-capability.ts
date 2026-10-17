import type { RuntimeStatus } from '../../shared/runtime-types'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'

/** An older runtime is told to update; the CLI never falls back to settings writes or a model. */
export async function requireJevRuntimeCapability(
  ctx: HandlerContext,
  capability: string,
  feature: string
): Promise<void> {
  const response = await ctx.client.call<RuntimeStatus>('status.get')
  if (!response.result.capabilities?.includes(capability)) {
    throw new RuntimeClientError(
      'unsupported_runtime_capability',
      `The selected runtime does not support ${feature}. Update that runtime; no settings or model fallback was used.`
    )
  }
}
