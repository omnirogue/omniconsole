import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { DiscussionWriteBoundary } from '@/components/next-step/DiscussionWriteBoundary'
import { translate as t } from '@/i18n/i18n'
import { InboxCompose } from './InboxCompose'
import { InboxNotice } from './InboxNotice'
import { inboxPeople, type InboxPerson } from './inbox-api'

export function InboxNewMessage({ onSent }: { onSent: () => void }) {
  const [people, setPeople] = useState<InboxPerson[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const open = async () => {
    setLoading(true)
    setError('')
    try {
      setPeople(await inboxPeople())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }
  return (
    <>
      <DiscussionWriteBoundary>
        <Button size="sm" disabled={loading} onClick={() => void open()}>
          {t('inbox.newMessage', 'New message')}
        </Button>
        {people && (
          <InboxCompose
            people={people}
            close={() => setPeople(null)}
            onSent={(person) => {
              setNotice(
                t('inbox.sentTo', 'Sent to {{name}}. It is in their Inbox now.', {
                  name: person.name
                })
              )
              onSent()
            }}
          />
        )}
      </DiscussionWriteBoundary>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <InboxNotice text={notice} dismiss={() => setNotice('')} />
    </>
  )
}
