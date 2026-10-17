import { translate } from '@/i18n/i18n'

export function InboxUnreadBadge({ count }: { count: number }) {
  return count > 0 ? (
    <span
      data-inbox-unread={count}
      aria-label={translate('inbox.unreadCount', '{{count}} unread', { count })}
      className="rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold tabular-nums text-primary-foreground"
    >
      {count}
    </span>
  ) : null
}
