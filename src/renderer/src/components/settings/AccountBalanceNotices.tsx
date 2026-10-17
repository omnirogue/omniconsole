import { AlertTriangle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function AccountBalanceNotices({
  model
}: {
  model: AccountsPaneSectionModel
}): React.JSX.Element {
  const {
    activeCodexAuthWarning,
    systemCodexMissingSignIn,
    accountRuntimeSentenceLabel,
    activeCodexAccountId,
    codexConfigSyncWarning,
    codexConfigSync
  } = model
  return (
    <>
      {activeCodexAuthWarning ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {systemCodexMissingSignIn
              ? translate(
                  'auto.components.settings.AccountsPane.codexSystemDefaultNeedsSignIn',
                  'No Codex sign-in was found for {{value0}}.',
                  { value0: accountRuntimeSentenceLabel }
                )
              : activeCodexAccountId
                ? translate(
                    'auto.components.settings.AccountsPane.75ca9b718e',
                    'Codex reported that the active account needs a fresh sign-in. Re-authenticate it before starting new Codex sessions.'
                  )
                : translate(
                    'auto.components.settings.AccountsPane.e4a28e8894',
                    'Codex reported that the {{value0}} login needs a fresh sign-in. Sign in again before starting new Codex sessions.',
                    { value0: accountRuntimeSentenceLabel }
                  )}
          </span>
        </div>
      ) : null}
      {codexConfigSyncWarning ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {codexConfigSyncWarning === 'managed-home-unavailable'
              ? translate(
                  'auto.components.settings.AccountsPane.codexConfigSyncManagedHomeUnavailable',
                  'OmniConsole could not read this account’s Codex files just now, so settings may not be syncing. This usually clears on its own — antivirus or a backup tool briefly locks them.'
                )
              : codexConfigSyncWarning === 'missing-source'
                ? translate(
                    'auto.components.settings.AccountsPane.codexConfigSyncMissingSource',
                    'Codex is still using the settings it last synced because {{value0}} is missing. Restore that file to resume syncing.',
                    { value0: codexConfigSync?.systemConfigPath ?? '' }
                  )
                : codexConfigSyncWarning === 'blank-source'
                  ? translate(
                      'auto.components.settings.AccountsPane.codexConfigSyncBlankSource',
                      'Codex is still using the settings it last synced because {{value0}} is empty. That is expected while a synced folder finishes downloading.',
                      { value0: codexConfigSync?.systemConfigPath ?? '' }
                    )
                  : translate(
                      'auto.components.settings.AccountsPane.codexConfigSyncUnreadableSource',
                      "Codex is still using the settings it last synced because {{value0}} could not be read. Check that file's permissions.",
                      { value0: codexConfigSync?.systemConfigPath ?? '' }
                    )}
          </span>
        </div>
      ) : null}
    </>
  )
}
