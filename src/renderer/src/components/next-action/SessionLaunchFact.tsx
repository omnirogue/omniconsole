import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { sessionContextKey, useSessionContext } from '@/lib/session-context-store'
import { useSessionLaunchRecord } from '@/lib/session-launch-record'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { launchManifestRows } from '../../../../shared/launch-manifest'

/**
 * Session details' "Launched with" row: the same list the launch review panel showed, so a running
 * session's agent, project, folder and attachments stay visible. A session launched before the
 * list was kept (or from another computer) shows its current attachments instead.
 */
export function SessionLaunchFact({ session }: { session: SidebarSession }): React.JSX.Element {
  const record = useSessionLaunchRecord(session.tabId ?? undefined)
  const attached = useSessionContext(sessionContextKey(session))
  const [open, setOpen] = useState(false)
  const rows = record
    ? launchManifestRows(record)
    : attached.map((item) => ({
        id: item.id,
        kind: 'attachment' as const,
        label: translate('nextAction.launchedWithAttachment', 'Attached {{kind}}', {
          kind: item.kind
        }),
        detail: item.title
      }))
  const summary = record
    ? translate('nextAction.launchedWithSummary', '{{count}} items', {
        count: rows.length
      })
    : rows.length
      ? translate('nextAction.launchedWithAttached', '{{count}} attached, launch list not kept', {
          count: rows.length
        })
      : translate('nextAction.launchedWithNothing', 'Nothing attached, launch list not kept')
  return (
    <div className="min-w-0 space-y-1 text-xs" data-next-action-fact="launched-with">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-[78px] shrink-0 text-muted-foreground">
          {translate('nextAction.launchedWith', 'Launched with')}
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1">
          <span className="text-muted-foreground">{summary}</span>
          {rows.length ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-1 text-xs text-muted-foreground"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? translate('nextAction.hide', 'hide') : translate('nextAction.show', 'show')}
            </Button>
          ) : null}
        </span>
      </div>
      {open ? (
        <ul className="space-y-0.5 pl-[86px]" data-launched-with-list>
          {rows.map((row) => (
            <li key={row.id} className="min-w-0 break-words" data-launched-with-item={row.kind}>
              <span className="text-muted-foreground">{row.label}: </span>
              {row.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
