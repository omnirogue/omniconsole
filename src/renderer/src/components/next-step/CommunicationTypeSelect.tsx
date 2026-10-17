import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { COMMUNICATION_TYPES, type CommunicationType } from '../../../../shared/communication-type'
import {
  communicationLabel,
  communicationExpectationLabel
} from '../native-chat/chat-communication-labels'

export function CommunicationTypeSelect({
  value,
  onChange,
  disabled = false
}: {
  value: CommunicationType | undefined
  onChange: (value: CommunicationType) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={value ?? ''}
        onValueChange={(next) => onChange(next as CommunicationType)}
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          className="w-40"
          aria-label={translate('chatDelivery.communicationType', 'Communication type')}
        >
          <SelectValue
            placeholder={translate('chatDelivery.communicationType', 'Communication type')}
          />
        </SelectTrigger>
        <SelectContent>
          {COMMUNICATION_TYPES.map((kind) => (
            <SelectItem key={kind} value={kind}>
              {communicationLabel(kind)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value ? (
        <span className="text-xs text-muted-foreground">
          {communicationExpectationLabel(value)}
        </span>
      ) : null}
    </div>
  )
}
