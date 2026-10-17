import { useState, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { SessionContextItemsEditor } from '@/components/session-context/SessionContextItemsEditor'
import {
  launchAttachmentSource,
  launchManifestPrompt,
  projectPointerText,
  type LaunchManifest
} from '../../../../shared/launch-manifest'
import { useLaunchReview, type LaunchReviewRequest } from './launch-review-store'

/**
 * The pre-launch panel (Sal, 2026-09-30: no hidden context). Every item the launch would attach
 * is listed here, removable or editable, and Start sends only what the panel shows.
 */
export function LaunchReviewDialog(): React.JSX.Element | null {
  const request = useLaunchReview((state) => state.request)
  const close = useLaunchReview((state) => state.close)
  if (!request) {
    return null
  }
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto scrollbar-sleek sm:max-w-2xl">
        <LaunchReviewBody request={request} onClose={close} />
      </DialogContent>
    </Dialog>
  )
}

function ReviewRow({
  id,
  label,
  children,
  onRemove,
  removeLabel,
  warning
}: {
  id: string
  label: string
  children: ReactNode
  onRemove?: () => void
  removeLabel?: string
  warning?: boolean
}) {
  return (
    <li
      data-launch-review-item={id}
      className={cn(
        'flex min-w-0 items-start gap-2 rounded border px-2 py-1.5 text-xs',
        warning && 'border-status-warning-border bg-status-warning-background'
      )}
    >
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1 space-y-1 break-words">{children}</div>
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={removeLabel}
          onClick={onRemove}
        >
          <X className="size-3" />
        </Button>
      ) : null}
    </li>
  )
}

function EditableText({
  value,
  onChange,
  label,
  placeholder,
  startOpen = false
}: {
  value: string
  onChange: (next: string) => void
  label: string
  placeholder?: string
  startOpen?: boolean
}) {
  const [open, setOpen] = useState(startOpen)
  if (!open) {
    return (
      <Button
        type="button"
        variant="link"
        size="xs"
        className="h-auto px-0 text-xs"
        onClick={() => setOpen(true)}
      >
        {translate('launchReview.showText', 'Show and edit text ({{count}} characters)', {
          count: value.trim().length
        })}
      </Button>
    )
  }
  return (
    <Textarea
      rows={Math.min(10, Math.max(3, value.split('\n').length))}
      value={value}
      aria-label={label}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

function LaunchReviewBody({
  request,
  onClose
}: {
  request: LaunchReviewRequest
  onClose: () => void
}) {
  const [draft, setDraft] = useState<LaunchManifest>(request.manifest)
  const [removed, setRemoved] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const { project, agent } = draft
  const update = (patch: Partial<LaunchManifest>) =>
    setDraft((current) => ({ ...current, ...patch }))
  const removeAttachment = (id: string) => {
    if (draft.sources[id] === 'project') {
      setRemoved((current) => [...current, id])
    }
    update({ attachments: draft.attachments.filter((item) => item.id !== id) })
  }
  const editAttachment = (id: string, content: string) =>
    update({
      attachments: draft.attachments.map((item) => (item.id === id ? { ...item, content } : item))
    })
  const remove = (title: string) =>
    translate('launchReview.remove', 'Leave {{title}} out', { title })
  return (
    <>
      <DialogHeader>
        <DialogTitle>{translate('launchReview.title', 'What this session gets')}</DialogTitle>
        <DialogDescription>
          {translate(
            'launchReview.help',
            'Review the context this launcher adds to the opening message. Remove or edit it before starting.'
          )}
        </DialogDescription>
      </DialogHeader>
      <ul className="space-y-1" data-launch-review-list>
        {draft.folder ? (
          <ReviewRow id="folder" label={translate('launchReview.folder', 'Folder')}>
            {translate(
              'launchReview.folderDetail',
              '{{name}} (sidebar filing only, sends nothing)',
              {
                name: draft.folder.name
              }
            )}
          </ReviewRow>
        ) : null}
        {project ? (
          <ReviewRow
            id="project"
            label={translate('launchReview.project', 'Project line')}
            onRemove={() => update({ project: null })}
            removeLabel={remove(project.line)}
          >
            {project.line}
          </ReviewRow>
        ) : null}
        {project?.pointer ? (
          <ReviewRow
            id="pointer"
            label={translate('launchReview.pointer', 'Project pointer')}
            onRemove={() => update({ project: { ...project, pointer: false } })}
            removeLabel={remove(translate('launchReview.pointer', 'Project pointer'))}
          >
            {projectPointerText(project, agent?.templateId)}
          </ReviewRow>
        ) : null}
        <ReviewRow
          id="agent"
          label={translate('launchReview.agent', 'Agent')}
          onRemove={agent ? () => update({ agent: null }) : undefined}
          removeLabel={agent ? remove(agent.name) : undefined}
        >
          {agent ? (
            <>
              <p>
                {agent.name}{' '}
                <span className="text-muted-foreground">
                  {agent.from === 'project'
                    ? translate('launchReview.agentFromProject', 'project agent')
                    : translate('launchReview.agentFromLauncher', 'launcher template')}
                </span>
              </p>
              {agent.instructions.trim() ? (
                <EditableText
                  value={agent.instructions}
                  label={translate('launchReview.agentText', 'Agent instructions')}
                  onChange={(instructions) =>
                    update({ agent: { ...agent, instructions, digest: undefined } })
                  }
                />
              ) : (
                <p className="text-muted-foreground">
                  {translate('launchReview.noInstructions', 'No instructions')}
                </p>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">
              {translate('launchReview.noAgent', 'None: the provider starts with no template')}
            </span>
          )}
        </ReviewRow>
        <ReviewRow id="task" label={translate('launchReview.task', 'Task')}>
          <EditableText
            startOpen
            value={draft.prompt}
            label={translate('launchReview.task', 'Task')}
            placeholder={translate('launchReview.taskPlaceholder', 'Optional first message')}
            onChange={(prompt) => update({ prompt })}
          />
        </ReviewRow>
        {draft.attachments.map((item) => (
          <ReviewRow
            key={item.id}
            id={item.id}
            label={item.kind}
            onRemove={() => removeAttachment(item.id)}
            removeLabel={remove(item.title)}
          >
            <p>
              {item.title}{' '}
              <span className="text-muted-foreground">
                {launchAttachmentSource(draft, item.id)}
                {item.hostId ? ` · ${item.hostId}` : ''}
              </span>
            </p>
            {item.uri ? <p className="truncate text-muted-foreground">{item.uri}</p> : null}
            {item.kind === 'instructions' ? (
              <EditableText
                value={item.content ?? ''}
                label={item.title}
                onChange={(content) => editAttachment(item.id, content)}
              />
            ) : null}
          </ReviewRow>
        ))}
        {draft.notOnHost.map((item) => (
          <ReviewRow
            key={item.id}
            id={`not-sent:${item.id}`}
            label={translate('launchReview.notSent', 'Not sent')}
            warning
          >
            {translate('launchReview.notOnHost', '{{title}} ({{kind}}) is not on {{host}}', {
              title: item.title,
              kind: item.kind,
              host: draft.hostLabel ?? translate('launchReview.thisHost', 'this host')
            })}
          </ReviewRow>
        ))}
      </ul>
      {adding ? (
        <SessionContextItemsEditor
          hideList
          items={draft.attachments}
          worktreeId={request.worktreeId}
          title={translate('launchReview.add', 'Add context')}
          help={translate('launchReview.addHelp', 'Added items go to this session only.')}
          onChange={async (next) => update({ attachments: next })}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="justify-self-start"
          data-launch-review-add
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3" />
          {translate('launchReview.addButton', 'Add context…')}
        </Button>
      )}
      <details className="text-xs" data-launch-review-message>
        <summary className="cursor-pointer text-muted-foreground">
          {translate('launchReview.message', 'Opening message, exactly as sent')}
        </summary>
        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded border bg-muted/40 p-2 font-mono text-[11px] scrollbar-sleek">
          {launchManifestPrompt(draft) ||
            translate('launchReview.noMessage', 'Nothing: the session opens empty.')}
        </pre>
      </details>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {translate('launchReview.cancel', 'Cancel')}
        </Button>
        <Button
          type="button"
          data-launch-review-start
          onClick={() => {
            onClose()
            request.onStart(draft, removed)
          }}
        >
          {translate('launchReview.start', 'Start session')}
        </Button>
      </DialogFooter>
    </>
  )
}
