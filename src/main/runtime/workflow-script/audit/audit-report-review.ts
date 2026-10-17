export type AuditReportCritique = {
  verdict: 'ready' | 'revise'
  gaps: string[]
  unsupportedClaims: string[]
}

export function auditReportCritique(value: unknown): AuditReportCritique | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const result = value as Partial<AuditReportCritique>
  if (
    !['ready', 'revise'].includes(result.verdict ?? '') ||
    !Array.isArray(result.gaps) ||
    !Array.isArray(result.unsupportedClaims) ||
    [...result.gaps, ...result.unsupportedClaims].some(
      (item) => typeof item !== 'string' || !item.trim()
    )
  ) {
    return undefined
  }
  return result as AuditReportCritique
}

export function auditCritiqueIsConsistent(critique: AuditReportCritique): boolean {
  return (
    critique.verdict === 'revise' ||
    (critique.gaps.length === 0 && critique.unsupportedClaims.length === 0)
  )
}

/** Host-owned review status must survive a writer's revision. */
export function auditReviewedMarkdown(
  markdown: string,
  critique: AuditReportCritique,
  revision = 4
): string {
  if (critique.verdict === 'ready') {
    return `${markdown}\n\n---\n\n### Review status\n\nThe critic reported no outstanding concerns. This model review does not independently establish that every claim is correct.`
  }
  const concerns = [
    ...critique.gaps.map((gap) => `Gap: ${gap}`),
    ...critique.unsupportedClaims.map((claim) => `Unsupported claim: ${claim}`)
  ].map((concern) =>
    concern
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join('\n')
  )
  const status =
    revision >= 5
      ? 'This revision has not received a further semantic review. The critic findings below are reproduced verbatim from before this revision. They have not been rechecked against the revised report; this workflow does not claim they are resolved or remain current defects.'
      : 'The critic requested changes. This revision has not received a further semantic review. The concerns below remain pending independent confirmation of their resolution.'
  return [markdown, '---', '### Review status', status, ...concerns].join('\n\n')
}
