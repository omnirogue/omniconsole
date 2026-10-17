/** Keyboard proof is recorded only by xterm input, never by startup or programmatic writes. */
const MAX_TRACKED_PTYS = 512
const MAX_LINES_PER_PTY = 8

export type TerminalKeyboardSubmitClaim = { readonly submittedAt: number }
type TypedSubmit = {
  text: string
  at: number
  claim?: { prompt: string; identity?: string; receipt: TerminalKeyboardSubmitClaim }
}

const submitsByPtyId = new Map<string, TypedSubmit[]>()

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function recordTerminalKeyboardSubmit(
  ptyId: string,
  line: string,
  now: number = Date.now()
): void {
  const previous = submitsByPtyId.get(ptyId)
  submitsByPtyId.delete(ptyId)
  const lines = [...(previous ?? []), { text: normalize(line), at: now }]
  submitsByPtyId.set(ptyId, lines.slice(-MAX_LINES_PER_PTY))
  if (submitsByPtyId.size > MAX_TRACKED_PTYS) {
    const oldest = submitsByPtyId.keys().next().value
    if (oldest !== undefined) {
      submitsByPtyId.delete(oldest)
    }
  }
}

/** When the person last pressed Enter in this terminal (xterm input only), or null. */
export function lastTerminalKeyboardSubmitAt(ptyId: string): number | null {
  return submitsByPtyId.get(ptyId)?.at(-1)?.at ?? null
}

/** Claims both proofs together; a repeated hook gets the same receipt, not another launch. */
export function claimTerminalKeyboardSubmit(
  ptyId: string,
  prompt: string,
  maxAgeMs: number,
  fallbackWindowMs: number,
  identity?: string,
  now: number = Date.now()
): TerminalKeyboardSubmitClaim | null {
  const lines = submitsByPtyId.get(ptyId)
  const wanted = normalize(prompt)
  if (!lines || !wanted) {
    return null
  }
  const fresh = (line: TypedSubmit, age: number) => now >= line.at && now - line.at <= age
  const replay = lines
    .toReversed()
    .find(
      (line) =>
        line.claim?.prompt === wanted && line.claim.identity === identity && fresh(line, maxAgeMs)
    )
  if (identity && replay) {
    return replay.claim!.receipt
  }

  const exact = lines.find((line) => !line.claim && line.text === wanted && fresh(line, maxAgeMs))
  const latest = lines.at(-1)!
  const submit = exact ?? (!latest.claim && fresh(latest, fallbackWindowMs) ? latest : undefined)
  if (!submit) {
    return replay?.claim?.receipt ?? null
  }

  const receipt = { submittedAt: submit.at }
  submit.claim = { prompt: wanted, identity, receipt }
  return receipt
}

export function resetTerminalKeyboardSubmitsForTests(): void {
  submitsByPtyId.clear()
}
