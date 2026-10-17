import { openrouterCandidates } from '../../../../shared/openrouter-route'
import { useId } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

/** Controlled route order: host/model refreshes never rewrite an operator's reviewed choices. */
export function FleetFallbackFields({
  primary,
  candidates,
  choices,
  problem,
  canEnable,
  onChange
}: {
  primary: string | null
  candidates: readonly string[] | undefined
  choices: readonly { id: string; label: string }[]
  problem: string | null
  canEnable: boolean
  onChange: (candidates: string[] | undefined) => void
}) {
  const id = useId()
  const occurrences = new Map<string, number>()
  const rows = candidates?.map((candidate) => {
    const occurrence = occurrences.get(candidate) ?? 0
    occurrences.set(candidate, occurrence + 1)
    // Invalid imported duplicates stay individually removable without making order the identity.
    return { candidate, key: JSON.stringify([candidate, occurrence]) }
  })
  const move = (index: number, offset: number): void => {
    if (!candidates || index < 1 || index + offset < 1 || index + offset >= candidates.length) {
      return
    }
    const next = [...candidates]
    ;[next[index], next[index + offset]] = [next[index + offset]!, next[index]!]
    onChange(next)
  }
  return (
    <div className="space-y-2 border-t border-border pt-3" data-fleet-fallback-editor>
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={candidates !== undefined}
          disabled={!candidates && !canEnable}
          onCheckedChange={(checked) => onChange(checked && primary ? [primary] : undefined)}
        />
        <Label htmlFor={id} className="text-xs">
          {translate('nextStep.fleetFallback.enable', 'Choose fallback models')}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'nextStep.fleetFallback.explanation',
          'The agent uses only the selected model unless you choose fallbacks. Models below are tried in the order you choose.'
        )}
      </p>
      {candidates !== undefined ? (
        <>
          <ol
            className="space-y-1"
            aria-label={translate('nextStep.fleetFallback.order', 'Reviewed model order')}
          >
            {rows?.map(({ candidate, key }, index) => (
              <li key={key} className="flex min-w-0 items-center gap-1 text-xs">
                <span className="min-w-0 flex-1 break-all">
                  {index + 1}. {candidate}
                </span>
                {index > 0 ? (
                  <>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={index === 1}
                      onClick={() => move(index, -1)}
                      aria-label={translate(
                        'nextStep.fleetFallback.earlier',
                        'Move {{model}} earlier',
                        { model: candidate }
                      )}
                    >
                      <ArrowUp className="size-3" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={index === candidates.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={translate(
                        'nextStep.fleetFallback.later',
                        'Move {{model}} later',
                        { model: candidate }
                      )}
                    >
                      <ArrowDown className="size-3" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => onChange(candidates.filter((_, at) => at !== index))}
                      aria-label={translate(
                        'nextStep.fleetFallback.remove',
                        'Remove {{model}} from fallback list',
                        { model: candidate }
                      )}
                    >
                      <X className="size-3" />
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ol>
          {primary && candidates[0] !== primary && canEnable ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={
                !openrouterCandidates.safeParse([
                  primary,
                  ...candidates.filter((candidate) => candidate !== primary)
                ]).success
              }
              onClick={() =>
                onChange([primary, ...candidates.filter((candidate) => candidate !== primary)])
              }
            >
              {translate('nextStep.fleetFallback.useSelectedFirst', 'Use selected model first')}
            </Button>
          ) : null}
          {canEnable ? (
            <div className="max-h-40 space-y-1 overflow-y-auto scrollbar-sleek">
              {choices
                .filter((choice) => choice.id !== primary && !candidates.includes(choice.id))
                .map((choice) => (
                  <Button
                    key={choice.id}
                    type="button"
                    size="xs"
                    variant="outline"
                    className="h-auto w-full justify-start whitespace-normal text-left"
                    disabled={!openrouterCandidates.safeParse([...candidates, choice.id]).success}
                    onClick={() => onChange([...candidates, choice.id])}
                  >
                    {translate('nextStep.fleetFallback.add', 'Add {{model}}', {
                      model: choice.label
                    })}
                  </Button>
                ))}
            </div>
          ) : null}
        </>
      ) : null}
      {problem ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  )
}
