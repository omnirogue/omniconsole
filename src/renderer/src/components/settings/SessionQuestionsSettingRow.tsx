import React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { normalizeSessionQuestionsSettings } from '../../../../shared/session-questions-settings'
import { translate } from '@/i18n/i18n'
import { SettingsSwitchRow } from './SettingsFormControls'

/** Needs you's questions with one-click answers (on by default), and turn-end questions (off by default). */
export function SessionQuestionsSettingRow({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (patch: Partial<GlobalSettings>) => unknown
}): React.JSX.Element {
  const current = normalizeSessionQuestionsSettings(settings.sessionQuestions)
  return (
    <>
      <SettingsSwitchRow
        label={translate(
          'sessionQuestions.inlineAnswers',
          'Answer session questions from Needs you'
        )}
        description={translate(
          'sessionQuestions.inlineAnswersHint',
          'Each question a session asks shows in Needs you with its options as buttons, so you can answer without opening the terminal.'
        )}
        checked={current.inlineAnswers}
        onChange={() =>
          void updateSettings({
            sessionQuestions: { ...current, inlineAnswers: !current.inlineAnswers }
          })
        }
      />
      <SettingsSwitchRow
        label={translate(
          'sessionQuestions.turnEndQuestions',
          'Treat a reply that ends in a question as waiting for you'
        )}
        description={translate(
          'sessionQuestions.turnEndQuestionsHint',
          'When a Claude or Codex reply ends by asking you something, show it as waiting in the sidebar, Needs you and OmniOS Questions. Sign-in links always show. Off by default, because an Outcome run would stop for you at each such question.'
        )}
        checked={current.turnEndQuestions}
        onChange={() =>
          void updateSettings({
            sessionQuestions: { ...current, turnEndQuestions: !current.turnEndQuestions }
          })
        }
      />
    </>
  )
}
