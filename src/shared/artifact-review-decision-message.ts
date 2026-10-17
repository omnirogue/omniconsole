import type { ArtifactReviewDecision } from './artifact-review'

/** Edits longer than this are cut; the full text stays readable with `omni artifacts status`. */
export const DECISION_EDITS_MAX_CHARS = 2_000

export const ARTIFACT_APPROVAL_SCOPE_LINE =
  'Anything that moves money, reaches a customer, changes ad budgets or grants access still needs its own approval.'

export type ArtifactDecisionMessageInput = {
  slug: string
  title: string
  shareUrl: string
  decision: ArtifactReviewDecision
  /** The session was asleep and this message woke it. */
  woke?: boolean
  /** A decision changed to Reject after the session already acted on an earlier one. */
  rejectedWhileWorking?: boolean
  /** Phase 2: another computer woke it because its own was off. */
  moved?: { from: string; to: string; folder: string; account: string | null }
}

function empty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === false ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && Object.keys(value as object).length === 0)
  )
}

function plain(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
}

/** The page's edits as `field: "value"` lines; empty fields are dropped as the page drops them. */
export function formatDecisionEdits(edits: unknown, slug: string): string | null {
  if (empty(edits)) {
    return null
  }
  const text =
    typeof edits === 'object' && !Array.isArray(edits)
      ? Object.entries(edits as Record<string, unknown>)
          .filter(([, value]) => !empty(value))
          .map(([field, value]) => `${field}: "${plain(value)}"`)
          .join('\n')
      : plain(edits)
  if (!text) {
    return null
  }
  return text.length > DECISION_EDITS_MAX_CHARS
    ? `${text.slice(0, DECISION_EDITS_MAX_CHARS)}… (cut; read all of them with: omni artifacts status ${slug} --json)`
    : text
}

function easternTime(iso: string): string {
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) {
    return iso
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ET`
}

function who(decision: ArtifactReviewDecision): string {
  const name = decision.by.name?.trim()
  const email = decision.by.email?.trim()
  if (name && email) {
    return `${name} (${email})`
  }
  return name || email || 'The reviewer'
}

/** The message a decision on a review page delivers into the publishing conversation. */
export function artifactDecisionMessage(input: ArtifactDecisionMessageInput): string {
  const { decision, slug } = input
  const page = `"${input.title || slug}"`
  const byLine = `By ${who(decision)} at ${easternTime(decision.at)} · ${input.shareUrl}`
  const comment = decision.comment?.trim() ? `Comment: "${decision.comment.trim()}"` : null
  const edits = formatDecisionEdits(decision.edits, slug)
  const editLines = edits ? [`Edits:\n${edits}`] : []
  const fields = decision.edits as Record<string, unknown> | null
  if (fields && (Array.isArray(fields.selected) || Array.isArray(fields.picks))) {
    const picks = Array.isArray(fields.picks)
      ? { picks: fields.picks }
      : { selected: fields.selected, titles: fields.titles }
    const json = JSON.stringify(picks)
    editLines.push(
      json.length <= DECISION_EDITS_MAX_CHARS
        ? `Picks (JSON): ${json}`
        : `Read structured picks with: omni artifacts status ${slug} --json`
    )
  }
  if (decision.decision === 'rejected') {
    return [
      `[OmniOS decision] Rejected: revision ${decision.revision} of ${page}`,
      byLine,
      ...(comment ? [comment] : []),
      input.rejectedWhileWorking
        ? `${decision.by.name || 'The reviewer'} changed the decision to Reject. Stop and take no further action.`
        : 'Do now: stop. Do not carry out the plan or publish it again.',
      `Read the saved decision any time: omni artifacts status ${slug} --json`
    ].join('\n')
  }
  if (decision.decision !== 'approved' && decision.decision !== 'changes_requested') {
    // Why: a decision this build does not know is never worded, or acted on, as an approval.
    return [
      `[OmniOS decision] "${String(decision.decision)}" on revision ${decision.revision} of ${page}`,
      byLine,
      ...(comment ? [comment] : []),
      'Do now: this is not an approval, so do not carry out the plan. Read the decision, and ask the person what they want if it is unclear.',
      `Read the saved decision any time: omni artifacts status ${slug} --json`
    ].join('\n')
  }
  const lines =
    decision.decision === 'changes_requested'
      ? [
          `[OmniOS decision] Changes requested on revision ${decision.revision} of ${page}`,
          byLine,
          ...(comment ? [comment] : []),
          ...editLines,
          `Do now: revise the plan to cover every point and publish it as a new revision of the same page (omni artifacts update <file> --review …). Do not carry out the plan. This session sleeps again after you publish.`
        ]
      : edits
        ? [
            `[OmniOS decision] Approved with edits: revision ${decision.revision} of ${page}`,
            byLine,
            ...(comment ? [comment] : []),
            ...editLines,
            `Do now: apply these edits and carry out the plan. If an edit changes money, a customer send, an ad budget or access, do not act: publish the edited version as revision ${decision.revision + 1} for approval (omni artifacts update <file> --review …).`
          ]
        : [
            `[OmniOS decision] Approved: revision ${decision.revision} of ${page}`,
            byLine,
            ...(comment ? [comment] : []),
            `Do now: carry out the plan exactly as approved in revision ${decision.revision}. This approval covers only what revision ${decision.revision} says.`,
            ARTIFACT_APPROVAL_SCOPE_LINE
          ]
  if (input.woke) {
    lines.push(
      'You were asleep waiting for this decision; this message woke the same conversation.'
    )
  }
  if (input.moved) {
    const { from, to, folder, account } = input.moved
    lines.push(
      `You were moved from ${from} to ${to} because ${from} was off. Your folder here is ${folder}.`,
      `Here you run with this computer's own accounts and logins${account ? ` (${account})` : ''}, not ${from}'s.`
    )
  }
  lines.push(`Read the saved decision any time: omni artifacts status ${slug} --json`)
  return lines.join('\n')
}
