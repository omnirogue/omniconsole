import type { IncomingHttpHeaders } from 'node:http'

const HEADER_PREFIXES = ['x-orca-', 'x-omni-', 'x-omniconsole-'] as const

/** Header names are a wire contract across independently updated hook hosts. */
export function readCompatibleAgentHookHeader(
  headers: IncomingHttpHeaders,
  suffix: string
): string | undefined {
  let value: string | undefined
  for (const prefix of HEADER_PREFIXES) {
    const candidate = headers[`${prefix}${suffix}`]
    if (candidate === undefined) {
      continue
    }
    if (typeof candidate !== 'string' || (value !== undefined && candidate !== value)) {
      throw new Error('Conflicting agent hook headers')
    }
    value = candidate
  }
  return value
}

export function hasValidAgentHookToken(headers: IncomingHttpHeaders, token: string): boolean {
  try {
    return token.length > 0 && readCompatibleAgentHookHeader(headers, 'agent-hook-token') === token
  } catch {
    return false
  }
}
