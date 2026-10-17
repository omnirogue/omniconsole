import { translate as t } from '@/i18n/i18n'

/** A one-line, dismissable confirmation under the Inbox toolbar (e.g. "Sent to Sal"). */
export function InboxNotice({ text, dismiss }: { text: string; dismiss: () => void }) {
  if (!text) {
    return null
  }
  return (
    <div role="status" className="border-b bg-muted/40 px-6 py-2 text-sm">
      {text}{' '}
      <button type="button" className="underline" onClick={dismiss}>
        {t('inbox.dismiss', 'Dismiss')}
      </button>
    </div>
  )
}
