import { Inbox } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { SidebarNavMemberButton } from './SidebarNavMemberButton'
import { useInboxUnread } from '@/components/inbox/inbox-unread'
import { InboxUnreadBadge } from '@/components/inbox/InboxUnreadBadge'

export function InboxSidebarEntry() {
  const active = useAppStore((state) => state.activeView === 'inbox')
  const open = useAppStore((state) => state.openInboxPage)
  const unread = useInboxUnread()
  return (
    <SidebarNavMemberButton
      icon={Inbox}
      label={translate('nav.inbox', 'Inbox')}
      active={active}
      onClick={open}
      badge={<InboxUnreadBadge count={unread.total} />}
    />
  )
}
