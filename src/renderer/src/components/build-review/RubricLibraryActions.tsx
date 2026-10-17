import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { saveJevLibraryRubric } from '../../../../shared/jev-rubrics'
import type { SavedReviewRubric } from '../../../../shared/review-rubrics'
import { readRubricsFile, rubricsFile } from '../../../../shared/rubric-library'

/**
 * Managing the saved rubrics: delete the one in use, and share them as a file the team imports.
 * Imports take the save policy Settings and agents use: built-in names are refused, replacing a
 * saved name needs confirmation, and the limits hold.
 */
export function RubricLibraryActions({
  saved,
  selectedName
}: {
  saved: readonly SavedReviewRubric[]
  /** The saved rubric in use, when it is one of the person's own. */
  selectedName?: string
}) {
  const updateSettings = useAppStore((s) => s.updateSettingsOrThrow)
  const [pendingImport, setPendingImport] = useState<SavedReviewRubric[] | null>(null)
  const applyImport = async (read: SavedReviewRubric[], replace = false) => {
    try {
      const reviewRubrics = read.reduce(
        (current, rubric) => saveJevLibraryRubric(current, rubric, replace),
        [...saved]
      )
      await updateSettings({ reviewRubrics })
      setPendingImport(null)
      toast.success(
        translate('rubrics.imported', 'Imported {{count}} rubrics.', { count: read.length })
      )
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : translate('rubrics.importFailed', 'Could not import the rubrics.')
      )
    }
  }
  const deleteRubric = async () => {
    if (!selectedName) {
      return
    }
    try {
      await updateSettings({
        reviewRubrics: saved.filter(
          (entry) => entry.name.toLowerCase() !== selectedName.toLowerCase()
        )
      })
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : translate('rubrics.deleteFailed', 'Could not delete the rubric.')
      )
    }
  }
  const exportRubrics = async () => {
    const result = await window.api.export.saveText({
      content: rubricsFile(saved),
      suggestedName: 'omni-rubrics.json',
      extensions: ['json'],
      filterName: translate('rubrics.fileFilter', 'Rubrics')
    })
    if (result.success) {
      toast.success(
        translate('rubrics.exported', 'Rubrics saved to {{path}}', { path: result.filePath })
      )
    } else if (!result.cancelled) {
      toast.error(result.error ?? translate('rubrics.exportFailed', 'Could not save the rubrics.'))
    }
  }
  const importRubrics = async () => {
    const result = await window.api.export.openText({
      extensions: ['json'],
      filterName: translate('rubrics.fileFilter', 'Rubrics')
    })
    if (!result.success) {
      if (!result.cancelled) {
        toast.error(result.error ?? translate('rubrics.importFailed', 'Could not open the file.'))
      }
      return
    }
    const read = readRubricsFile(result.content)
    if ('error' in read) {
      toast.error(read.error)
      return
    }
    try {
      // Validate the entire file before offering to replace any saved entry.
      read.reduce((current, rubric) => saveJevLibraryRubric(current, rubric, true), [...saved])
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : translate('rubrics.importFailed', 'Could not import the rubrics.')
      )
      return
    }
    if (
      read.some((rubric) =>
        saved.some((entry) => entry.name.toLowerCase() === rubric.name.toLowerCase())
      )
    ) {
      setPendingImport(read)
      return
    }
    await applyImport(read)
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {selectedName ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="px-0 text-destructive"
            onClick={() => void deleteRubric()}
          >
            {translate('rubrics.delete', 'Delete "{{name}}"', { name: selectedName })}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="link"
          size="xs"
          className="px-0"
          disabled={!saved.length}
          onClick={() => void exportRubrics()}
        >
          {translate('rubrics.export', 'Export your rubrics')}
        </Button>
        <Button
          type="button"
          variant="link"
          size="xs"
          className="px-0"
          onClick={() => void importRubrics()}
        >
          {translate('rubrics.import', 'Import rubrics')}
        </Button>
      </div>
      {pendingImport ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {translate(
              'rubrics.importReplaceHint',
              'This file contains names already in your saved rubrics. Replace those rubrics to import it?'
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void applyImport(pendingImport, true)}
            >
              {translate('rubrics.importReplace', 'Replace and import')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPendingImport(null)}>
              {translate('rubrics.importCancel', 'Cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
