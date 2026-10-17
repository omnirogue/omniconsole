import {
  sessionManageActorTitle,
  sessionManagePromptMarker,
  type SessionManageActor,
  type SessionPromptAnswer
} from '../../shared/session-manage-types'
import { encodeCodexQuestionOptionId } from '../codex/codex-structured-prompt-replies'
import type { AdPauseTarget } from '../next-steps/next-step-ad-pause-policy'
import { checkPromptHardStops } from './session-manage-answer-hard-stops'
import type { SessionAnswerSelection } from './session-manage-answer'
import { SessionManageRefusal } from './session-manage-refusal'
import { asyncQuestionAnswerMessage } from './session-prompt-hook'
import {
  freeEntryOption,
  isKnownOneTimeAllow,
  isKnownDeny,
  persistentApproval,
  promptTextIncomplete,
  promptHasControlCharacters,
  questionOptionKey,
  type SessionPrompt
} from './session-prompt'

function refuse(message: string): never {
  throw new SessionManageRefusal(`${message} Nothing was sent.`)
}

export function selectSessionAnswer(
  prompt: SessionPrompt,
  answer: SessionPromptAnswer,
  actor: SessionManageActor,
  /** The answered session, whose ad-pause choice applies. */
  target?: AdPauseTarget
): SessionAnswerSelection {
  const { ask, options, delivery } = prompt
  if (answer.kind === 'allow' || answer.kind === 'deny') {
    if (ask.kind !== 'permission') {
      refuse(
        '--allow and --deny require a permission prompt; use --choose or --text for questions.'
      )
    }
    // An allowlist of known one-time allow / deny shapes: any other option is never chosen.
    const candidates = options.filter((option) =>
      answer.kind === 'allow'
        ? isKnownOneTimeAllow(option, delivery.kind)
        : isKnownDeny(option, delivery.kind)
    )
    if (candidates.length !== 1) {
      refuse(
        `There is no unambiguous ${answer.kind === 'allow' ? 'one-time allow' : 'deny/no'} option.`
      )
    }
    const chosen = candidates[0]!
    if (answer.kind === 'allow') {
      if ([ask.text, ...prompt.commandText].some(persistentApproval)) {
        refuse(
          'This prompt requests a persistent or scoped permission; answer it in its own session.'
        )
      }
      if (!prompt.readable) {
        refuse('The requested tool or command cannot be read completely.')
      }
      // A clipped label anywhere could be a persistent option cut down to look like a one-time one.
      if (options.some(({ label }) => promptTextIncomplete(label))) {
        refuse('An option on this prompt cannot be read completely.')
      }
      checkPromptHardStops(prompt, chosen.label, target)
    }
    return { ...chosen }
  }
  if (ask.kind !== 'question') {
    refuse(
      '--choose and --text require a question; a permission prompt takes only --allow or --deny.'
    )
  }
  if (!prompt.readable) {
    refuse('The question cannot be read completely.')
  }
  if ([ask.text, ...prompt.commandText].some(persistentApproval)) {
    refuse(
      'This question requests a persistent or scoped permission; answer it in its own session.'
    )
  }
  // A free-entry row before the last is not a layout this can verify: the whole question refuses.
  if (options.slice(0, -1).some(({ label }) => freeEntryOption(label))) {
    refuse(
      'This question has a free-entry option ("Other", "Type something") before its last option; answer it in its own session.'
    )
  }
  if (answer.kind === 'choose') {
    const chosen = options.find((option) => option.n === answer.choice)
    if (!chosen || promptTextIncomplete(chosen.label)) {
      refuse('That option is not fully readable or is not offered by this question.')
    }
    if (freeEntryOption(chosen.label)) {
      refuse('A free-entry option ("Other", "Type something") is never chosen.')
    }
    if (persistentApproval(chosen.label)) {
      refuse(
        'Persistent approval options ("don\'t ask again", "always", "for this session" and the like) are never selected.'
      )
    }
    if (delivery.kind === 'pty' && !questionOptionKey(chosen)) {
      refuse('That option has no single verified key on this screen; answer it in its own session.')
    }
    checkPromptHardStops(prompt, chosen.label, target)
    return { ...chosen }
  }
  if (!answer.text.trim() || promptHasControlCharacters(answer.text)) {
    refuse('An answer must contain text and no terminal control characters.')
  }
  if (persistentApproval(answer.text)) {
    refuse(
      'Persistent approval answers ("always", "don\'t ask again", "for this session" and the like) are never sent.'
    )
  }
  checkPromptHardStops(prompt, answer.text, target)
  if (delivery.kind === 'message') {
    const label = `${sessionManagePromptMarker(sessionManageActorTitle(actor))}${answer.text}`
    return { label, value: asyncQuestionAnswerMessage(prompt.subject, label) }
  }
  if (delivery.kind !== 'structured' || !delivery.freeTextQuestionId) {
    refuse('Free text is unsupported for this prompt; answer it in its own session.')
  }
  const label = `${sessionManagePromptMarker(sessionManageActorTitle(actor))}${answer.text}`
  return { label, value: encodeCodexQuestionOptionId(delivery.freeTextQuestionId, label) }
}
