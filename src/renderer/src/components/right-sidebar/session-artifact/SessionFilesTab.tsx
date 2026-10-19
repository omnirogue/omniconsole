import { useState } from 'react'
import { ArrowLeft, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { SessionFilesAndLinksCard } from '@/components/next-action/SessionFilesAndLinksCard'
import type { SessionOutputs } from '@/components/next-action/use-session-outputs'
import type { FilesAndLinksCard } from '@/lib/session-files-and-links'
import { SessionFilePreview } from './SessionFilePreview'
import type { SessionPanelItem } from './session-panel-items'

export type SessionPanelFile = Extract<SessionPanelItem, { kind: 'file' }> & {
  name: string
  location: string
}

/**
 * Plans and files this session created, newest first, each previewed right here on a click; the
 * pull requests and links it produced sit underneath. Nothing opens until a row is pressed.
 */
export function SessionFilesTab({
  files,
  links,
  outputs,
  worktreeId,
  hostId,
  visible,
  pickedKey,
  selectionRevision,
  deliverables
}: {
  files: readonly SessionPanelFile[]
  links: readonly FilesAndLinksCard[]
  outputs: SessionOutputs
  worktreeId: string
  hostId: string | null
  visible: boolean
  /** A file link clicked in the conversation opens straight into its preview. */
  pickedKey: string | null
  selectionRevision: number
  /** The deliverable check's block for this session, above the files (W22-20). */
  deliverables?: React.ReactNode
}): React.JSX.Element {
  const pickedFile = pickedKey?.startsWith('file:') ? pickedKey : null
  const [open, setOpen] = useState<{ key: string | null; revision: number }>({
    key: pickedFile,
    revision: selectionRevision
  })
  const openKey = open.revision === selectionRevision ? open.key : pickedFile
  const previewed = openKey ? files.find((file) => file.key === openKey) : undefined
  if (previewed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="m-1 self-start gap-1 text-xs text-muted-foreground"
          onClick={() => setOpen({ key: null, revision: selectionRevision })}
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {translate('sessionPanel.allFiles', 'All files ({{count}})', { count: files.length })}
        </Button>
        <SessionFilePreview key={previewed.key} item={previewed} visible={visible} />
      </div>
    )
  }
  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-2" data-session-files="">
      {deliverables}
      {files.length > 0 ? (
        <ul className="space-y-0.5">
          {files.map((file) => (
            <li key={file.key}>
              <button
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                title={file.path}
                onClick={() => setOpen({ key: file.key, revision: selectionRevision })}
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">{file.name}</span>
                {file.location ? (
                  <span className="max-w-[45%] shrink truncate text-muted-foreground">
                    {file.location}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {links.length > 0 ? (
        <>
          <p className="mb-1.5 mt-3 px-2 text-[11px] font-medium text-muted-foreground">
            {translate('sessionPanel.links', 'Pull requests and links')}
          </p>
          <ul className="space-y-1.5 px-1">
            {links.map((card) => (
              <SessionFilesAndLinksCard
                key={card.key}
                card={card}
                worktreeId={worktreeId}
                hostId={hostId}
                target={outputs.target}
                liveness={card.type === 'link' ? outputs.liveness.get(card.url) : undefined}
              />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  )
}
