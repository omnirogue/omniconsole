import { z } from 'zod'

// Selectors are opaque: validate without trimming, sorting or rewriting them.
export const openrouterApiId = z
  .string()
  .min(3)
  .max(512)
  .refine(
    (value) =>
      value.split('/').length >= 2 &&
      value.split('/').every((part) => part.length > 0) &&
      !value.startsWith('openrouter/') &&
      !/\s|\0/.test(value)
  )
export const openrouterCandidates = z
  .array(openrouterApiId)
  .min(1)
  .max(16)
  .refine((values) => new Set(values).size === values.length)
export function validOpenRouterRoute(actor: {
  agent: string
  model?: string
  openrouterCandidates?: unknown
}): boolean {
  if (
    actor.agent === 'omp' &&
    actor.model?.startsWith('openrouter/') &&
    !openrouterApiId.safeParse(actor.model.slice(11)).success
  ) {
    return false
  }
  if (actor.openrouterCandidates === undefined) {
    return true
  }
  const parsed = openrouterCandidates.safeParse(actor.openrouterCandidates)
  return parsed.success && actor.agent === 'omp' && actor.model === `openrouter/${parsed.data[0]}`
}
export function assertOpenRouterRoute(actor: Parameters<typeof validOpenRouterRoute>[0]): void {
  if (!validOpenRouterRoute(actor)) {
    throw new Error('OpenRouter candidates require OMP and the exact selected model first.')
  }
}
