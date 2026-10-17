import type {
  NextStepDraft,
  NextStepRecipient,
  NextStepAfterStep
} from '../../../../../shared/next-step-draft'

export type MenuLevel = {
  id?: string
  recipients: NextStepRecipient[]
  mode: 'handoff' | 'review'
}

export function draftWithLevels(draft: NextStepDraft, levels: readonly MenuLevel[]): NextStepDraft {
  return {
    ...draft,
    mode: levels[0]?.mode,
    recipients:
      levels[0]?.recipients.map((recipient) => ({
        ...recipient,
        key: `${levels[0]?.id ?? 'level-1'}:${recipient.key}`
      })) ?? [],
    after: levels.slice(1).flatMap((level, index) =>
      level.recipients.map((recipient): NextStepAfterStep => {
        if (recipient.kind === 'person') {
          // Why: a review at any level returns to me; without the ask it compiles as a handoff
          // of ownership and the conversation is wrongly recorded as someone else's.
          return {
            ...recipient,
            key: `${level.id ?? index + 2}:${recipient.key}`,
            ...(level.mode === 'review' ? { action: 'review' as const } : {}),
            level: index + 2
          }
        }
        const { agent, model, effort, accountChoiceId, openrouterCandidates, ...rest } = recipient
        return {
          ...rest,
          key: `${level.id ?? index + 2}:${recipient.key}`,
          presetId: recipient.presetId ?? 'review',
          actor: {
            agent,
            model,
            effort,
            accountChoiceId,
            ...(openrouterCandidates ? { openrouterCandidates: [...openrouterCandidates] } : {})
          },
          level: index + 2
        }
      })
    )
  }
}

export function pickLevelRecipient(level: MenuLevel, recipient: NextStepRecipient): MenuLevel {
  if (level.mode === 'handoff') {
    return { ...level, recipients: [recipient] }
  }
  const existing = level.recipients.some((entry) => entry.key === recipient.key)
  const first = level.recipients[0]
  const next =
    first?.kind === 'agent' && recipient.kind === 'agent'
      ? {
          ...recipient,
          presetId: first.presetId,
          instructions: first.instructions,
          rounds: 1,
          ...(first.agent === recipient.agent
            ? {
                model: first.model,
                effort: first.effort,
                accountChoiceId: first.accountChoiceId,
                openrouterCandidates: first.openrouterCandidates?.slice()
              }
            : {})
        }
      : recipient
  return {
    ...level,
    recipients: existing
      ? level.recipients.filter((entry) => entry.key !== recipient.key)
      : [...level.recipients, next]
  }
}
