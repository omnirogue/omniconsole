import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate as t } from '@/i18n/i18n'
import { DiscussionWriteBoundary } from '@/components/next-step/DiscussionWriteBoundary'
import { InboxCompose, type ComposeKind } from './InboxCompose'
import { InboxAgentAction } from './InboxAgentAction'
import { InboxNotice } from './InboxNotice'
import { useInboxPeople } from './use-inbox-people'

/** Reuse the upstream composer from Inbox and Work, refreshing their shared history. */
export function DiscussionComposeAction({
  kind,
  project = '',
  refresh
}: {
  kind: ComposeKind
  project?: string
  refresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [instruction, setInstruction] = useState<string | null>(null)
  return (
    <>
      <Button size="sm" disabled={kind === 'room' && !project} onClick={() => setOpen(true)}>
        {kind === 'message' ? t('inbox.newMessage', 'New message') : t('inbox.newRoom', 'New room')}
      </Button>
      <InboxNotice text={notice} dismiss={() => setNotice('')} />
      {open && (
        <DiscussionWriteBoundary>
          <ComposeRoster
            kind={kind}
            project={project}
            close={() => setOpen(false)}
            prepare={(text) => {
              setOpen(false)
              setInstruction(text)
            }}
            onSent={(name) => {
              setNotice(t('inbox.sentTo', 'Sent to {{name}}. It is in their Inbox now.', { name }))
              refresh()
            }}
          />
        </DiscussionWriteBoundary>
      )}
      {instruction && (
        <InboxAgentAction instruction={instruction} close={() => setInstruction(null)} />
      )}
    </>
  )
}

function ComposeRoster({
  kind,
  project,
  close,
  prepare,
  onSent
}: {
  kind: ComposeKind
  project: string
  close: () => void
  prepare: (text: string) => void
  onSent: (name: string) => void
}) {
  const [revision, setRevision] = useState(0)
  const { people, error, loading } = useInboxPeople(revision)
  if (kind === 'message' && (loading || error || !people.length)) {
    return (
      <div className="space-y-2 text-sm">
        <p role={error ? 'alert' : 'status'}>
          {error ||
            (loading
              ? t('handoff.loadingPeople', 'Loading people…')
              : t('inbox.noPeople', 'No colleagues are available on this connection.'))}
        </p>
        {!loading && (
          <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
            {t('inbox.refresh', 'Refresh')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={close}>
          {t('inbox.cancel', 'Cancel')}
        </Button>
      </div>
    )
  }
  return (
    <InboxCompose
      kind={kind}
      project={project}
      people={people}
      close={close}
      prepare={prepare}
      onSent={(person) => onSent(person.name)}
    />
  )
}
