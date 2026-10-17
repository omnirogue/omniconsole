import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'
import { HandoffFilePreview, previewKind } from './HandoffFilePreview'

export function HandoffFiles({
  threadId,
  files,
  onDownload
}: {
  threadId: string
  files: HandoffDetail['files']
  onDownload: (file: HandoffDetail['files'][number]) => Promise<void>
}) {
  const [previewId, setPreviewId] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      {files
        .filter((file) => file.current)
        .map((file) => (
          <div key={file.id} className="rounded-md border">
            <div className="flex items-center justify-between gap-3 p-3">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                disabled={!file.available || !previewKind(file.name)}
                aria-expanded={previewId === file.id}
                onClick={() => setPreviewId((value) => (value === file.id ? null : file.id))}
              >
                <p className="truncate text-sm">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {translate('handoffs.version03283', 'Version ')}
                  {file.version} · {file.size.toLocaleString()}{' '}
                  {translate('handoffs.bytesdaf52', 'bytes')}
                  {!file.available && translate('handoffs.unavailable80bcb', ' · unavailable')}
                </p>
              </button>
              {file.available && previewKind(file.name) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPreviewId((value) => (value === file.id ? null : file.id))}
                >
                  {previewId === file.id
                    ? translate('handoffs.hidePreview', 'Hide')
                    : translate('handoffs.preview', 'Preview')}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={!file.available}
                onClick={() => void onDownload(file)}
              >
                {translate('handoffs.downloada479c', 'Download')}
              </Button>
            </div>
            {previewId === file.id && (
              <div className="border-t">
                <HandoffFilePreview threadId={threadId} file={file} />
              </div>
            )}
          </div>
        ))}
    </div>
  )
}
