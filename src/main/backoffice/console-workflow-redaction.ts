import { redactValue } from '../observability/redactor'
import { redactValueKeepingSignInLinks } from '../observability/sign-in-link-redaction'

const MAX_REQUEST_BYTES = 1_048_576

/** Every spelling a credential takes inside serialized JSON, longest first so an encoded form is never half-replaced. */
export function consoleWorkflowCredentialVariants(bearer: string): string[] {
  return [
    ...new Set([
      bearer,
      JSON.stringify(bearer).slice(1, -1),
      encodeURIComponent(bearer),
      Buffer.from(bearer).toString('base64')
    ])
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
}

/** Include the actual in-memory credential: opaque test and future tokens have no fingerprint. */
export function redactConsoleWorkflowValue(
  value: unknown,
  bearer: string | null,
  keepSignInLinks = false
): unknown {
  let serialized = JSON.stringify(
    keepSignInLinks ? redactValueKeepingSignInLinks(value) : redactValue(value)
  )
  if (serialized === undefined) {
    return null
  }
  if (bearer) {
    for (const variant of consoleWorkflowCredentialVariants(bearer)) {
      serialized = serialized.split(variant).join('[redacted]')
    }
  }
  return JSON.parse(serialized) as unknown
}

/** Never silently change a reviewed graph or persist a credential in its request body. */
export function serializeConsoleWorkflowRequest(
  value: unknown,
  bearer: string,
  redact: (value: unknown) => unknown = (input) => redactConsoleWorkflowValue(input, bearer),
  maxBytes = MAX_REQUEST_BYTES
): string {
  const serialized = JSON.stringify(value)
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized) > maxBytes ||
    serialized !== JSON.stringify(redact(value))
  ) {
    throw new Error('The workflow request contains protected data or exceeds its size limit.')
  }
  return serialized
}
