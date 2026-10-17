import { useRef, useState } from 'react'
import { FileText, Folder, MessageSquare, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { SessionContextAttachment } from '../../../../shared/session-context-attachments'
import { SessionContextDocuments } from './SessionContextDocuments'
import { SessionContextFiles } from './SessionContextFiles'
import { SessionContextSkills } from './SessionContextSkills'

type Section = 'documents' | 'files' | 'skills' | 'instructions'

/** The attachment list and its pickers over `items`; the caller decides where a change goes. */
export function SessionContextItemsEditor({
  items,
  onChange,
  worktreeId,
  statusText,
  hideList = false,
  title = translate('sessionContext.title', 'Session context'),
  help = translate(
    'sessionContext.help',
    'Search and click to add. Attachments stay with the session when you reopen it.'
  )
}: {
  items: readonly SessionContextAttachment[]
  onChange: (next: SessionContextAttachment[]) => Promise<void>
  worktreeId: string | null
  statusText?: string
  /** The caller lists the items itself (the launch review panel); only the pickers show. */
  hideList?: boolean
  title?: string
  help?: string
}) {
  const [section, setSection] = useState<Section>('documents')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const saving = useRef(false)
  const chosen = new Set(items.map((item) => item.id))
  const persist = async (next: SessionContextAttachment[]) => {
    if (saving.current) {
      throw new Error(
        translate('sessionContext.waitForSave', 'Wait for the current attachment to finish saving.')
      )
    }
    saving.current = true
    setBusy(true)
    setError('')
    try {
      await onChange(next)
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  const add = async (added: SessionContextAttachment[]) => {
    const unique = new Map(items.map((item) => [item.id, item]))
    for (const item of added) {
      unique.set(item.id, item)
    }
    await persist([...unique.values()])
  }
  const fail = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason))
  const sections = [
    {
      id: 'documents' as const,
      title: translate('sessionContext.documents', 'OmniOS & Slite'),
      icon: FileText
    },
    {
      id: 'files' as const,
      title: translate('sessionContext.files', 'Files & folders'),
      icon: Folder
    },
    {
      id: 'skills' as const,
      title: translate('sessionContext.skills', 'Skills'),
      icon: Sparkles
    },
    {
      id: 'instructions' as const,
      title: translate('sessionContext.instructions', 'Instructions'),
      icon: MessageSquare
    }
  ]
  return (
    <section className="min-w-0 space-y-2" aria-label={title} data-session-context-editor>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium">{title}</h4>
        <span className="text-xs text-muted-foreground">
          {translate('sessionContext.itemCount', '{{count}} attached', {
            count: items.length
          })}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{help}</p>
      {!hideList && !!items.length && (
        <ul className="max-h-36 space-y-1 overflow-y-auto scrollbar-sleek">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex min-w-0 items-center gap-2 rounded border px-2 py-1 text-xs"
            >
              <span className="min-w-0 flex-1 truncate" title={item.uri ?? item.content}>
                {item.title}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {item.kind === 'omnios'
                  ? translate('sessionContext.omnios', 'OmniOS')
                  : item.kind === 'slite'
                    ? translate('sessionContext.slite', 'Slite')
                    : item.kind === 'instructions'
                      ? translate('sessionContext.instructions', 'Instructions')
                      : item.repo
                        ? translate('sessionContext.fromRepo', 'from {{repo}}', {
                            repo: item.repo.gitIdentity
                          })
                        : item.kind}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                aria-label={translate('sessionContext.remove', 'Remove {{title}}', {
                  title: item.title
                })}
                onClick={() =>
                  void persist(items.filter((entry) => entry.id !== item.id)).catch(fail)
                }
              >
                <X className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div
        className="flex flex-wrap gap-1"
        aria-label={translate('sessionContext.sources', 'Context sources')}
      >
        {sections.map(({ id, title: label, icon: Icon }) => (
          <Button
            key={id}
            type="button"
            variant={section === id ? 'secondary' : 'ghost'}
            size="xs"
            aria-pressed={section === id}
            onClick={() => setSection(id)}
          >
            <Icon className="size-3" />
            {label}
          </Button>
        ))}
      </div>
      {section === 'documents' && (
        <SessionContextDocuments chosen={chosen} busy={busy} onAdd={add} onError={setError} />
      )}
      {section === 'files' && (
        <SessionContextFiles
          worktreeId={worktreeId}
          chosen={chosen}
          busy={busy}
          onAdd={add}
          onError={setError}
        />
      )}
      {section === 'skills' && (
        <SessionContextSkills
          worktreeId={worktreeId}
          chosen={chosen}
          busy={busy}
          onAdd={add}
          onError={setError}
        />
      )}
      {section === 'instructions' && (
        <div className="space-y-2">
          <Textarea
            rows={4}
            maxLength={12_000}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            aria-label={translate(
              'sessionContext.customInstructions',
              'Custom session instructions'
            )}
            placeholder={translate(
              'sessionContext.instructionsPlaceholder',
              'Instructions for this session…'
            )}
          />
          <Button
            type="button"
            size="xs"
            disabled={busy || !instructions.trim()}
            onClick={() => {
              const text = instructions.trim()
              void add([
                {
                  id: `instructions:${crypto.randomUUID()}`,
                  kind: 'instructions',
                  title: text.split('\n')[0]!.slice(0, 100),
                  content: text
                }
              ])
                .then(() => setInstructions(''))
                .catch(fail)
            }}
          >
            {translate('sessionContext.addInstructions', 'Add instructions')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {statusText && (
        <p role="status" className="text-xs text-muted-foreground">
          {statusText}
        </p>
      )}
    </section>
  )
}
