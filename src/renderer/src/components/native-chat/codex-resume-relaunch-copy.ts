import { translate } from '@/i18n/i18n'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import type { CodexResumeRelaunchRefusal } from './codex-resume-relaunch-plan'
import { nativeChatSessionChoiceLabel } from './native-chat-session-option-labels'

/** `<model label> · <effort label>`, or the model alone when no effort is named. */
export function codexResumeRelaunchLabel(
  values: { model: string; effort?: string },
  models: readonly CatalogModel[]
): string {
  const modelLabel = models.find((model) => model.id === values.model)?.label ?? values.model
  if (!values.effort) {
    return modelLabel
  }
  return `${modelLabel} · ${nativeChatSessionChoiceLabel({ value: values.effort, label: values.effort })}`
}

export function codexResumeRelaunchRefusalCopy(refusal: CodexResumeRelaunchRefusal): string {
  switch (refusal.code) {
    case 'no-pty':
      return translate(
        'components.native-chat.composer.noPty',
        'No live terminal — toggle back to reconnect.'
      )
    case 'remote':
      return translate(
        'components.native-chat.composer.relaunchRefusedRemote',
        "Model and effort can't be changed from chat for a remote Codex session. Open Terminal and use /model."
      )
    case 'no-thread':
      return translate(
        'components.native-chat.composer.relaunchRefusedNoThread',
        "Codex hasn't reported a session to resume yet. Send one message, then change this."
      )
    case 'working':
      return translate(
        'components.native-chat.composer.relaunchRefusedWorking',
        'Codex is still working. Wait for the turn to finish, then change this.'
      )
    case 'in-flight':
      return translate(
        'components.native-chat.composer.relaunchRefusedInFlight',
        'A restart is already in progress for this conversation.'
      )
    case 'account-restart-pending':
      return translate(
        'components.native-chat.composer.relaunchRefusedAccountRestart',
        'An account restart is pending for this pane. Finish that first.'
      )
    case 'unsupported-effort':
      return translate(
        'components.native-chat.composer.relaunchRefusedUnsupportedEffort',
        "{{value0}} doesn't support {{value1}} effort.",
        {
          value0: refusal.model,
          value1: nativeChatSessionChoiceLabel({ value: refusal.effort, label: refusal.effort })
        }
      )
    case 'plan-failed':
      return translate(
        'components.native-chat.composer.relaunchRefusedPlan',
        "Couldn't build the Codex resume command: {{value0}}",
        { value0: refusal.detail }
      )
  }
}

export function codexResumeRelaunchSameValueCopy(label: string): string {
  return translate(
    'components.native-chat.composer.relaunchRefusedSameValue',
    'Codex is already using {{value0}}.',
    { value0: label }
  )
}

export function codexResumeRelaunchModelUnknownCopy(): string {
  return translate(
    'components.native-chat.composer.relaunchRefusedModelUnknown',
    "Codex hasn't reported its model yet. Pick a model first."
  )
}

export function codexResumeRelaunchUnavailableCopy(): string {
  return translate(
    'components.native-chat.composer.relaunchUnavailable',
    "Codex restarts aren't available in this pane."
  )
}
