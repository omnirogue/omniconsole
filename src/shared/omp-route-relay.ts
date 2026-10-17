import { z } from 'zod'
import { openrouterApiId, openrouterCandidates, validOpenRouterRoute } from './openrouter-route'

export const OMP_ROUTE_RELAY_CAPABILITY = 'omp-openrouter-routing-v1' as const
export const OMP_ROUTE_RELAY_DISCOVER = 'agent.ompRouteDiscoverV1'
export const OMP_ROUTE_RELAY_PREPARE = 'agent.ompRoutePrepareV1'
export const OMP_ROUTE_RELAY_UNAVAILABLE =
  'omp_route_capability_unavailable: SSH host requires an updated relay and OMP 18.2 or later.'

export const ompRelayRouteRequest = z
  .object({
    model: z
      .string()
      .refine(
        (id) => id.startsWith('openrouter/') && openrouterApiId.safeParse(id.slice(11)).success
      ),
    openrouterCandidates: openrouterCandidates.optional(),
    agentArgs: z.string().max(32_768),
    approval: z.boolean()
  })
  .strict()
  .refine((route) => validOpenRouterRoute({ agent: 'omp', ...route }))

export type OmpRelayRouteRequest = z.infer<typeof ompRelayRouteRequest>
export type OmpRelayRoutePrepared = {
  capability: typeof OMP_ROUTE_RELAY_CAPABILITY
  agentArgs: string
}

/** Route launches accept permission switches only; paths, auth and plugins stay host-owned. */
export function assertOmpRelayArgs(tokens: readonly string[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === '--yolo') {
      continue
    }
    if (
      tokens[index] === '--approval-mode' &&
      ['write', 'always-ask', 'yolo'].includes(tokens[index + 1])
    ) {
      index += 1
      continue
    }
    throw new Error(
      'omp_route_capability_unavailable: SSH OMP routes do not accept custom launcher arguments.'
    )
  }
}
