import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { ROOM_PURPOSES, type RoomBrief } from './inbox-room-brief'
import { translate as t } from '@/i18n/i18n'

export function InboxRoomBriefFields({
  value,
  change
}: {
  value: RoomBrief
  change: (value: RoomBrief) => void
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="room-purpose">{t('inbox.room.purpose', 'Purpose')}</Label>
        <Select
          value={value.purpose}
          onValueChange={(purpose: RoomBrief['purpose']) => change({ ...value, purpose })}
        >
          <SelectTrigger id="room-purpose">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(ROOM_PURPOSES).map(([key, title]) => (
              <SelectItem key={key} value={key}>
                {title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="room-outcome">{t('inbox.room.expectedOutcome', 'Expected outcome')}</Label>
        <Input
          id="room-outcome"
          value={value.outcome}
          maxLength={240}
          placeholder={t(
            'inbox.room.whatShouldWeLeaveThisRoom',
            'What should we leave this room with?'
          )}
          onChange={(event) => change({ ...value, outcome: event.target.value })}
        />
      </div>
      <details className="space-y-3 rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {t('inbox.room.sharedContextBrief', 'Shared context brief')}
        </summary>
        <p className="text-xs text-muted-foreground">
          {t(
            'inbox.room.writeOnlyWhatParticipantsShouldSee',
            'Write only what participants should see. Linked session history stays private.'
          )}
        </p>
        <Label htmlFor="room-progress">{t('inbox.room.currentProgress', 'Current progress')}</Label>
        <Textarea
          id="room-progress"
          rows={2}
          maxLength={400}
          value={value.progress}
          onChange={(event) => change({ ...value, progress: event.target.value })}
        />
        <Label htmlFor="room-attempted">{t('inbox.room.alreadyTried', 'Already tried')}</Label>
        <Textarea
          id="room-attempted"
          rows={2}
          maxLength={400}
          value={value.attempted}
          onChange={(event) => change({ ...value, attempted: event.target.value })}
        />
        <Label htmlFor="room-links">
          {t(
            'inbox.room.fileOrPrLinksOneHttps',
            'File or PR links (one HTTPS link per line, up to four)'
          )}
        </Label>
        <Textarea
          id="room-links"
          rows={2}
          value={value.references.join('\n')}
          onChange={(event) => change({ ...value, references: event.target.value.split('\n') })}
        />
      </details>
    </div>
  )
}
