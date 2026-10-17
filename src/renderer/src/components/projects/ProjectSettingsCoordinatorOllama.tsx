import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useLocalOllamaInventory } from '@/components/sidebar/session-folders/new-conversation/local-ollama/use-local-ollama-inventory'
import { translate } from '@/i18n/i18n'
import {
  ollamaTagFromOpenCodeModelId,
  openCodeOllamaModelId
} from '../../../../shared/local-ollama-launch'

/** The installed Ollama model the chat runs on; a recorded tag not installed here stays pickable. */
export function ProjectSettingsCoordinatorOllama({
  id,
  model,
  onChange
}: {
  id: string
  model: string | undefined
  onChange: (model: string) => void
}): React.JSX.Element {
  const { inventory } = useLocalOllamaInventory(true)
  const recorded = ollamaTagFromOpenCodeModelId(model)
  const installed = inventory?.status === 'connected' ? inventory.models.map((row) => row.name) : []
  const tags = recorded && !installed.includes(recorded) ? [recorded, ...installed] : installed
  return (
    <div className="space-y-1" data-project-settings-coordinator-ollama="">
      <Label htmlFor={id} className="text-xs">
        {translate('projects.settings.coordinatorOllamaModel', 'Ollama model')}
      </Label>
      {tags.length > 0 ? (
        <Select
          value={recorded ?? undefined}
          onValueChange={(tag) => onChange(openCodeOllamaModelId(tag))}
        >
          <SelectTrigger id={id} className="w-64">
            <SelectValue
              placeholder={translate('projects.settings.coordinatorOllamaPick', 'Pick a model')}
            />
          </SelectTrigger>
          <SelectContent>
            {tags.map((tag) => (
              <SelectItem key={tag} value={tag}>
                {tag}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="text-xs text-muted-foreground">
          {inventory?.status === 'disconnected'
            ? inventory.message
            : translate(
                'projects.settings.coordinatorOllamaNone',
                'No Ollama models on this computer yet. Pull one from New thread › Local Ollama.'
              )}
        </p>
      )}
    </div>
  )
}
