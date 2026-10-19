/** The first prompt of a fresh session that replaces a review page's publisher. */

import type { ClaimableDelivery } from '../work-delivery/work-delivery-kind'

type ContinuationCapsule = {
  goal?: string
  objective?: string
  summary?: string
  repo?: string
  branch?: string
  commit?: string
  head_sha?: string
  files?: string[]
  touchedFiles?: string[]
  touched_files?: string[]
  verify?: string[] | string
  verificationCommands?: string[] | string
  verification_cmd?: string
  next_steps?: string[] | string
  nextSteps?: string[] | string
  next_step_on_approve?: string
  next_step_on_change?: string
}

type BriefContext = {
  slug?: string
  title?: string
  shareUrl?: string
  continuationCapsule?: ContinuationCapsule
}

const asList = (value: string[] | string | undefined): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : typeof value === 'string' && value.trim().length > 0
      ? [value.trim()]
      : []

function formatContinuationCapsule(capsule: ContinuationCapsule | undefined): string {
  if (!capsule || typeof capsule !== 'object') {
    return ''
  }
  const lines: string[] = ['Continuation Capsule:']
  const goal = capsule.goal ?? capsule.objective
  if (goal) {
    lines.push(`- Goal: ${goal}`)
  }
  if (capsule.summary) {
    lines.push(`- Summary: ${capsule.summary}`)
  }
  const commit = capsule.commit ?? capsule.head_sha
  if (capsule.repo || capsule.branch || commit) {
    lines.push(`- Git: ${[capsule.repo, capsule.branch, commit].filter(Boolean).join(' @ ')}`)
  }
  const files = capsule.files ?? capsule.touchedFiles ?? capsule.touched_files
  if (Array.isArray(files) && files.length > 0) {
    lines.push(`- Files: ${files.join(', ')}`)
  }
  const verify = asList(capsule.verify ?? capsule.verificationCommands ?? capsule.verification_cmd)
  if (verify.length > 0) {
    lines.push(`- Verify: ${verify.join(' && ')}`)
  }
  const next = asList(
    capsule.next_steps ??
      capsule.nextSteps ??
      [capsule.next_step_on_approve, capsule.next_step_on_change].filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0
      )
  )
  if (next.length > 0) {
    lines.push(`- Next steps: ${next.join('; ')}`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

export function reviewRespawnBrief(delivery: ClaimableDelivery): string {
  const context = delivery.context as BriefContext
  const page = context.title ? `“${context.title}”` : (context.slug ?? delivery.workItem)
  const capsuleBlock = formatContinuationCapsule(context.continuationCapsule)
  return [
    `You are taking over the work behind the review page ${page}${context.shareUrl ? ` (${context.shareUrl})` : ''}. The session that published it can no longer be reopened (its transcript or its folder is gone), so you are its replacement: work in this folder, with this model and effort.`,
    capsuleBlock,
    context.slug
      ? `Read the page and its saved decision first: omni artifacts status ${context.slug} --json`
      : '',
    `The decision that needs you now:\n\n${delivery.text}`
  ]
    .filter(Boolean)
    .join('\n\n')
}
