/**
 * The cloud may have acted on the request without confirming it: no answer, a 5xx (a gateway
 * can hide a committed write) or an unreadable success. Never proof the request was refused.
 */
export class HostedEvolveOutcomeUnknownError extends Error {}

// Failures before any byte reached the cloud; every other transport failure may follow a send.
const UNSENT_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'])

/** A fetch that threw: refused only when nothing was sent, otherwise an unknown outcome. */
export function hostedEvolveTransportFailure(pathname: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error)
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof code === 'string' && UNSENT_ERROR_CODES.has(code)
    ? new Error(`Hosted Evolve request failed (${pathname}): ${reason}`)
    : new HostedEvolveOutcomeUnknownError(`Omnisi Cloud did not answer (${pathname}): ${reason}`)
}
