import type { SessionReviewAssignment } from './session-chain-review'
import { SESSION_VERDICT_MARKER } from './session-chain-verdict'

export type SessionReviewInstructionOptions = {
  /** The reviewer seat's own step id, which its verdict envelope must name back. */
  stepId: string
  /** The brief already ends with the verdict suffix; a second marker would read as ambiguous. */
  verdictSuffix?: boolean
}

/** Asks for the bound envelope: a verdict naming another seat or version is refused, not counted. */
export function buildSessionReviewInstructions(
  review: SessionReviewAssignment,
  options: SessionReviewInstructionOptions
): string {
  const payload = {
    kind: 'review',
    status: 'pass|findings|fail|insufficient_evidence',
    stepId: options.stepId,
    attemptId: '<the Launch attempt id from this brief>',
    candidateVersion: review.candidateVersion,
    blockingFindings: ['what blocks and where'],
    notes: 'optional'
  }
  return [
    `Review group ${review.groupId}, round ${review.round} of at most ${review.maxRounds}.`,
    `Review immutable candidate version: ${review.candidateVersion}.`,
    'Inspect and report findings only. Do not edit the candidate or its source files.',
    review.adversarial
      ? 'Use adversarial scrutiny: challenge assumptions and try to break the result.'
      : null,
    ...(options.verdictSuffix
      ? []
      : [
          'End your response with exactly one machine-readable verdict line, as its final non-empty line, and quote no other verdict line anywhere in your report:',
          `${SESSION_VERDICT_MARKER} ${JSON.stringify(payload)}`
        ]),
    'Use pass only when there are no blocking findings; findings and fail must each name at least one. Use insufficient_evidence when you could not judge, and name exactly what is missing — never infer a pass. Cite the exact files and the candidate version you inspected. A missing or malformed verdict cannot pass, and silence never means agreement.'
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}
