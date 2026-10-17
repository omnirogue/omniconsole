import { useState } from 'react'
import { Bot, User } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { OrgChartPerson } from '../../../../shared/console-companies-contract'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'

export function recipientPhoto(
  person: TeamRosterPerson & { employee_id?: string | null; email?: string | null },
  chart: readonly OrgChartPerson[]
): string | undefined {
  if (person.photo_url || person.image_url) {
    return person.photo_url || person.image_url
  }
  const match =
    chart.find((entry) => entry.id === person.id) ??
    chart.find((entry) => entry.employee_id === (person.employee_id ?? person.id)) ??
    (person.email
      ? chart.find((entry) => entry.email?.toLowerCase() === person.email?.toLowerCase())
      : undefined)
  return match?.photo_url || undefined
}

export function RecipientAvatar({
  name,
  photoUrl,
  agent = false
}: {
  name?: string
  photoUrl?: string
  agent?: boolean
}): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string>()
  if (agent) {
    return (
      <span
        data-testid="recipient-robot"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full recipient-identity-ai"
      >
        <Bot className="size-4" aria-hidden="true" />
        <span className="sr-only">{translate('nextStep.ai', 'AI')}</span>
      </span>
    )
  }
  const initials = name
    ?.trim()
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <span
      data-testid="recipient-human"
      className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full recipient-identity-human text-xs"
      aria-hidden="true"
    >
      {photoUrl && failedUrl !== photoUrl ? (
        <img
          src={photoUrl}
          alt=""
          className="size-full object-cover"
          onError={() => setFailedUrl(photoUrl)}
        />
      ) : (
        initials || <User className="size-4" />
      )}
    </span>
  )
}
