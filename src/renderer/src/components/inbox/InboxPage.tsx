import { useState } from 'react'
import { Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { useAppStore } from '@/store'
import { translate as t } from '@/i18n/i18n'
import { DiscussionWorkspace } from './DiscussionWorkspace'
import { useBackofficeWorkFocus } from '@/components/task-page/backoffice/backoffice-work-selection'
import { InboxRequests } from './InboxRequests'
import { useInboxUnread } from './inbox-unread'
import { InboxUnreadBadge } from './InboxUnreadBadge'

export default function InboxPage() {
  const scope = useHandoffScope()
  return <InboxAccount key={scope} scope={scope} />
}

function InboxAccount({ scope }: { scope: string }) {
  const [tab, setTab] = useState<'discussions' | 'handoffs'>('discussions')
  const unread = useInboxUnread()
  const openTaskPage = useAppStore((state) => state.openTaskPage)
  const onOpenTask = (taskId: string) => {
    useBackofficeWorkFocus.getState().focus({ scope, taskId, lens: 'all' })
    openTaskPage({ taskSource: 'backoffice' })
  }
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      data-testid="inbox-page"
    >
      <header className="border-b px-6 py-5">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Inbox className="size-5" aria-hidden />
          {t('nav.inbox', 'Inbox')}
        </h1>
        <nav className="mt-3 flex gap-2" aria-label={t('inbox.sections', 'Inbox sections')}>
          <Button
            size="sm"
            variant={tab === 'discussions' ? 'secondary' : 'ghost'}
            aria-pressed={tab === 'discussions'}
            onClick={() => setTab('discussions')}
          >
            {t('discussions.title', 'Discussions')}
            <InboxUnreadBadge count={unread.messages} />
          </Button>
          <Button
            size="sm"
            variant={tab === 'handoffs' ? 'secondary' : 'ghost'}
            aria-pressed={tab === 'handoffs'}
            onClick={() => setTab('handoffs')}
          >
            {t('inbox.handoffRequests', 'Handoff requests')}
            <InboxUnreadBadge count={unread.handoffs} />
          </Button>
        </nav>
      </header>
      {tab === 'discussions' ? (
        <DiscussionWorkspace scope={scope} onOpenTask={onOpenTask} />
      ) : (
        <InboxRequests key={tab} scope={scope} kind={tab} onOpenTask={onOpenTask} />
      )}
    </div>
  )
}
