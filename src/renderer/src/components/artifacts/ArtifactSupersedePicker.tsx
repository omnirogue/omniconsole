import { useMemo, useState } from 'react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { artifactSlugFromReference } from '../../../../shared/artifact-review'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { artifactName, formatArtifactUpdatedCompact } from './artifact-display-labels'

/** Loaded rows that can be a successor, newest first: never superseded, never the pages being closed. */
export function artifactSuccessorCandidates(
  items: readonly ArtifactListItem[],
  exclude: ReadonlySet<string>
): ArtifactListItem[] {
  return items
    .filter((item) => !exclude.has(item.artifact.slug) && !item.artifact.supersededBy)
    .sort((left, right) => right.artifact.updatedAt.localeCompare(left.artifact.updatedAt))
}

export function ArtifactSupersedePicker({
  open,
  items,
  exclude,
  onPick,
  onClose
}: {
  open: boolean
  items: readonly ArtifactListItem[]
  /** The page (or pages) being superseded; a page cannot supersede itself. */
  exclude: ReadonlySet<string>
  onPick: (slug: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [pasted, setPasted] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const candidates = useMemo(() => artifactSuccessorCandidates(items, exclude), [items, exclude])

  const submitPasted = (): void => {
    const slug = artifactSlugFromReference(pasted)
    if (!slug) {
      setPasteError(
        translate(
          'auto.components.artifacts.supersede.pasteInvalid',
          'Paste a page link or its id.'
        )
      )
      return
    }
    if (exclude.has(slug)) {
      setPasteError(
        translate('auto.components.artifacts.supersede.self', 'A page cannot supersede itself.')
      )
      return
    }
    onPick(slug)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPasted('')
          setPasteError(null)
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-lg gap-3 p-4">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.artifacts.supersede.title', 'Superseded by…')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.artifacts.supersede.description',
              'Choose the page that replaces it.'
            )}
          </DialogDescription>
        </DialogHeader>
        <Command className="rounded-md border border-border">
          <CommandInput
            placeholder={translate('auto.components.artifacts.supersede.search', 'Search pages')}
          />
          <CommandList className="max-h-64">
            <CommandEmpty>
              {translate('auto.components.artifacts.supersede.empty', 'No loaded page matches.')}
            </CommandEmpty>
            {candidates.map((item) => (
              <CommandItem
                key={item.artifact.slug}
                value={`${artifactName(item)} ${item.artifact.slug}`}
                onSelect={() => onPick(item.artifact.slug)}
              >
                <span className="min-w-0 flex-1 truncate">{artifactName(item)}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {formatArtifactUpdatedCompact(item.artifact.updatedAt)}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        <form
          className="flex items-start gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            submitPasted()
          }}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <Input
              value={pasted}
              aria-invalid={pasteError !== null}
              placeholder={translate(
                'auto.components.artifacts.supersede.paste',
                'Or paste a link or id'
              )}
              onChange={(event) => {
                setPasted(event.target.value)
                setPasteError(null)
              }}
            />
            {pasteError ? <p className="text-xs text-destructive">{pasteError}</p> : null}
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={!pasted.trim()}>
            {translate('auto.components.artifacts.supersede.use', 'Use')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
