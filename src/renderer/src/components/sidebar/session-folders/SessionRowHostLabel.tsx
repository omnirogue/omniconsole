import { translate } from '@/i18n/i18n'

/**
 * The computer a row runs on, as muted text after its name (the search hit's `{host} · {when}`).
 * Why text, not a chip: it shares a compact row's one line, and shrinks well before the name does.
 */
export function SessionRowHostLabel({ label }: { label: string }): React.JSX.Element {
  return (
    <span
      className="ml-1.5 min-w-[3ch] max-w-[45%] shrink-[100] truncate text-[11px] font-normal text-muted-foreground"
      data-session-host-label=""
      title={translate('sessionHosts.rowHostTitle', 'On {{host}}', { host: label })}
    >
      {label}
    </span>
  )
}
