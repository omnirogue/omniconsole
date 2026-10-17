import { useId, useState } from 'react'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { fetchSessionArtifactReview } from '@/components/right-sidebar/session-artifact/session-artifact-client'
import {
  artifactReviewThreadTitle,
  type HandoffArtifactReview
} from '../../../../../shared/handoff-artifact-review'
import { resolvePersonReviewPage } from './person-review-page'

/**
 * "Ask them to review a page": an omnios page (`…/a/<slug>`) the people decide on, signed in.
 * The link is read once here for the page's title; the recipient is made a reviewer only when the
 * request is sent, from the main process (`artifact-review-grant.ts`).
 */
export function PersonReviewPageField({
  value,
  onChange
}: {
  value: HandoffArtifactReview | undefined
  onChange: (next: HandoffArtifactReview | undefined) => void
}) {
  const id = useId()
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const label = t('upNext.send.reviewPage', 'Ask them to review a page (optional)')
  if (value) {
    return (
      <div className="space-y-1" data-person-review-page={value.slug}>
        <p className="text-xs font-medium">{label}</p>
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs" title={value.url ?? value.slug}>
            {artifactReviewThreadTitle(value)}
          </span>
          <Button size="xs" variant="ghost" onClick={() => onChange(undefined)}>
            {t('upNext.send.reviewPageRemove', 'Remove')}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t(
            'upNext.send.reviewPageHow',
            'They decide on the page; their decision comes back into this thread.'
          )}
        </p>
      </div>
    )
  }
  const attach = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await resolvePersonReviewPage(link, fetchSessionArtifactReview)
      if (result.ok) {
        setLink('')
        if (result.warning) {
          setMessage(result.warning)
        }
        onChange(result.review)
      } else {
        setMessage(result.message)
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={`${id}-page`} className="text-xs">
        {label}
      </Label>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          id={`${id}-page`}
          value={link}
          placeholder={t('upNext.send.reviewPagePlaceholder', 'Paste the page link')}
          onChange={(event) => setLink(event.target.value)}
        />
        <Button size="xs" variant="outline" disabled={busy || !link.trim()} onClick={attach}>
          {t('upNext.send.reviewPageAttach', 'Attach')}
        </Button>
      </div>
      {message && (
        <p role="alert" className="text-xs" data-person-review-page-message>
          {message}
        </p>
      )}
    </div>
  )
}
