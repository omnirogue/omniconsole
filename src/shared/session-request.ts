/**
 * Asking someone for the session they are working in, mid-flight.
 *
 * There was no way to say "pass me that session" — a handoff could only be offered, never asked
 * for. A request is an ordinary handoff thread with action `decide`, so it lands in the current
 * owner's Needs You and sits in the asker's Waiting For with no new machinery at all. What makes
 * it a request rather than a note is one machine-readable line in its body, which the owner's
 * ✓ Done then reads to hand the session over instead of just marking the thread done.
 *
 * The line is readable by a person too: a hub without this build still shows a sensible request.
 */
export const SESSION_REQUEST_MARKER = 'omni-session-request: v1'
export const SESSION_REQUEST_ACTION = 'decide' as const

export type SessionRequest = {
  /** The workspace the asked-for session runs in, on the owner's computer. */
  workspacePath: string
  /** The session's row in the console ledger, so the trail survives the handover. */
  ledgerId?: string
  /** What the asker wants it for; shown above the marker line. */
  reason: string
  sessionLabel: string
}

function encode(value: string): string {
  return value.replaceAll('\n', ' ').trim()
}

export function buildSessionRequestBody(request: SessionRequest): string {
  const fields = [
    `workspace=${encode(request.workspacePath)}`,
    request.ledgerId ? `ledger=${encode(request.ledgerId)}` : null,
    `session=${encode(request.sessionLabel)}`
  ].filter((field): field is string => field !== null)
  return [encode(request.reason), '', `${SESSION_REQUEST_MARKER} ${fields.join(' ')}`]
    .join('\n')
    .slice(0, 8192)
}

/** The request a thread body carries, or null when it is an ordinary handoff. */
export function parseSessionRequestBody(body: string): SessionRequest | null {
  const line = body
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(SESSION_REQUEST_MARKER))
  if (!line) {
    return null
  }
  const fields = new Map<string, string>()
  // Values may contain spaces (a path, a session name), so each key starts a new field and runs
  // to the next key; splitting on whitespace alone would truncate every real workspace path.
  const rest = line.slice(SESSION_REQUEST_MARKER.length).trim()
  const pattern = /(workspace|ledger|session)=(.*?)(?=\s+(?:workspace|ledger|session)=|$)/g
  for (const match of rest.matchAll(pattern)) {
    fields.set(match[1]!, match[2]!.trim())
  }
  const workspacePath = fields.get('workspace')
  if (!workspacePath) {
    return null
  }
  const reason = body.split('\n')[0]?.trim() ?? ''
  return {
    workspacePath,
    ...(fields.get('ledger') ? { ledgerId: fields.get('ledger')! } : {}),
    reason,
    sessionLabel: fields.get('session') ?? workspacePath
  }
}

export function sessionRequestTitle(sessionLabel: string, askerName: string): string {
  return `${askerName} asked for: ${sessionLabel}`.slice(0, 160)
}

/** The memo the owner sends back with the session, once they accept. */
export function sessionHandoverMemo(input: {
  sessionLabel: string
  reason: string
  ownerName: string
}): string {
  return [
    `${input.ownerName} handed over ${input.sessionLabel}.`,
    input.reason ? `You asked: ${input.reason}` : null,
    'The work in progress is committed on the handoff branch below.'
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}
