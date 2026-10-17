import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function PromptEngineerStatus({ disabled, onGo }: { disabled: boolean; onGo: () => void }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {translate(
          'chatActions.promptEngineerInline',
          'Prompt Engineer: refine in this chat, then press Go.'
        )}
      </span>
      <Button
        type="button"
        size="sm"
        disabled={disabled}
        onClick={(event) => {
          if (event.detail <= 1) {
            onGo()
          }
        }}
      >
        {translate('chatActions.promptEngineerGo', 'Go')}
      </Button>
    </div>
  )
}
