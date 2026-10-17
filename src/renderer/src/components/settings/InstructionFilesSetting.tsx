import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { useActiveWorkspace } from './instruction-files-active-workspace'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { joinPath } from '@/lib/path'

/** Instruction files OpenCode and the other runners read before any agent template. */
const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const

type FileStatus = 'loaded' | 'missing' | 'unreadable' | 'binary'

type InstructionFile = {
  path: string
  scope: 'project' | 'global'
  status: FileStatus
  content: string
  /** Why the file could not be read, for the row. */
  detail?: string
  /** A muted line under the row, for a state that is not an error. */
  note?: string
}

function isMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // Why: Node formats absence as "ENOENT: no such file or directory, open '…'"; match that whole shape.
  return /ENOENT: no such file or directory, \w+ '/.test(message)
}

async function readProjectFile(path: string): Promise<InstructionFile> {
  try {
    const file = await window.api.fs.readFile({ filePath: path })
    return file.isBinary
      ? { path, scope: 'project', status: 'binary', content: '' }
      : { path, scope: 'project', status: 'loaded', content: file.content }
  } catch (error) {
    // Why: only a confirmed absence may offer "Add"; a denied read must never be overwritten.
    return isMissing(error)
      ? { path, scope: 'project', status: 'missing', content: '' }
      : {
          path,
          scope: 'project',
          status: 'unreadable',
          content: '',
          detail: error instanceof Error ? error.message : String(error)
        }
  }
}

async function readGlobalFile(): Promise<InstructionFile | null> {
  const api = window.api?.localOllama
  if (!api) {
    return null
  }
  let result: Awaited<ReturnType<typeof api.readGlobalInstructions>>
  try {
    result = await api.readGlobalInstructions()
  } catch (error) {
    return {
      path: '',
      scope: 'global',
      status: 'unreadable',
      content: '',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
  if (!result.ok) {
    return {
      path: result.path,
      scope: 'global',
      status: 'unreadable',
      content: '',
      detail: result.message
    }
  }
  if (result.content !== null) {
    return { path: result.path, scope: 'global', status: 'loaded', content: result.content }
  }
  return {
    path: result.path,
    scope: 'global',
    status: 'missing',
    content: '',
    ...(result.fallbackPath
      ? {
          note: translate(
            'components.settings.instructionFiles.globalFallback',
            'Until this file exists, OpenCode reads {{path}} instead. Creating it takes over.',
            { path: result.fallbackPath }
          )
        }
      : {})
  }
}

/** Shows what the active workspace's sessions read, and edits those files in place. */
export function InstructionFilesSetting(): React.JSX.Element {
  const workspace = useActiveWorkspace()
  const [files, setFiles] = useState<InstructionFile[]>([])
  const [openPath, setOpenPath] = useState<string | null>(null)
  // Why: one draft per file, so opening another file never discards unsaved edits.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // Why: a save must compare against the text present when it lands, without side effects in an updater.
  const draftsRef = useRef(drafts)
  useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])
  const [saving, setSaving] = useState(false)
  const loadGeneration = useRef(0)
  const workspacePath = workspace?.host === 'local' ? workspace.path : null

  const shownPath = useRef(workspacePath)
  // Why: written in an effect, never during render; `load` compares against it after awaits.
  useEffect(() => {
    shownPath.current = workspacePath
  }, [workspacePath])
  const load = useCallback(async (): Promise<void> => {
    // Why: a slow load, or a save that finished after the pane moved on, must not replace
    // the current workspace's list.
    if (shownPath.current !== workspacePath) {
      return
    }
    const mine = ++loadGeneration.current
    const next: InstructionFile[] = []
    if (workspacePath) {
      for (const name of PROJECT_FILES) {
        next.push(await readProjectFile(joinPath(workspacePath, name)))
      }
    }
    const global = await readGlobalFile()
    if (global) {
      next.push(global)
    }
    if (mine === loadGeneration.current && shownPath.current === workspacePath) {
      setFiles(next)
    }
  }, [workspacePath])

  useEffect(() => {
    void load()
  }, [load])

  const draftOf = (file: InstructionFile): string => drafts[file.path] ?? file.content
  const setDraft = (file: InstructionFile, value: string): void =>
    setDrafts((current) => ({ ...current, [file.path]: value }))
  const clearDraft = (path: string): void =>
    setDrafts((current) => {
      const { [path]: _dropped, ...rest } = current
      return rest
    })
  const shown = files.filter(
    (file) =>
      file.scope === 'global' || file.status !== 'missing' || drafts[file.path] !== undefined
  )
  const addable = files.find(
    (file) =>
      file.scope === 'project' && file.status === 'missing' && file.path.endsWith('AGENTS.md')
  )

  const save = async (file: InstructionFile): Promise<void> => {
    const content = draftOf(file)
    setSaving(true)
    try {
      if (file.scope === 'global') {
        const result = await window.api.localOllama!.writeGlobalInstructions({ content })
        if (!result.ok) {
          throw new Error(result.message)
        }
      } else {
        await window.api.fs.writeFile({ filePath: file.path, content })
      }
      toast.success(
        translate('components.settings.instructionFiles.saved', 'Saved {{path}}.', {
          path: file.path
        })
      )
      // Why: only the text that was written is cleared, and the editor closes only then;
      // edits typed during the save stay open and unsaved.
      const fullySaved = draftsRef.current[file.path] === content
      if (fullySaved) {
        setDrafts((current) => {
          const { [file.path]: _saved, ...rest } = current
          return rest
        })
        setOpenPath((open) => (open === file.path ? null : open))
      }
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  const startFile = (file: InstructionFile): void => {
    setDraft(
      file,
      file.scope === 'global'
        ? `# ${translate('components.settings.instructionFiles.globalHeading', 'Rules for every OpenCode session')}\n\n`
        : `# ${workspace?.name ?? ''}\n\n`
    )
    setOpenPath(file.path)
  }
  const statusLabel = (file: InstructionFile): string | null => {
    if (file.status === 'missing') {
      return translate('components.settings.instructionFiles.missing', 'not found')
    }
    if (file.status === 'unreadable') {
      return translate('components.settings.instructionFiles.unreadable', 'not readable')
    }
    if (file.status === 'binary') {
      return translate('components.settings.instructionFiles.binary', 'not a text file')
    }
    return null
  }

  return (
    <section id="instruction-files" data-settings-section="instruction-files" className="space-y-4">
      <SettingsSubsectionHeader
        title={
          workspace
            ? translate(
                'components.settings.instructionFiles.titleFor',
                'Instruction files · {{name}}',
                { name: workspace.name }
              )
            : translate('components.settings.instructionFiles.title', 'Instruction files')
        }
        description={translate(
          'components.settings.instructionFiles.description',
          'The instruction files sessions in the active workspace read before any agent template: the workspace’s own AGENTS.md or CLAUDE.md, plus the global rules that OpenCode and Local Ollama sessions also read. Open one to edit it here.'
        )}
        action={
          workspacePath && addable && drafts[addable.path] === undefined ? (
            <Button type="button" size="sm" variant="outline" onClick={() => startFile(addable)}>
              {translate('components.settings.instructionFiles.create', 'Add AGENTS.md')}
            </Button>
          ) : undefined
        }
      />
      <div className="rounded-lg border border-border">
        {!workspace ? (
          <div className="px-3 py-2 text-[13px] text-muted-foreground">
            {translate(
              'components.settings.instructionFiles.noWorkspace',
              'Select a workspace in the sidebar to see its files.'
            )}
          </div>
        ) : workspace.host === 'remote' ? (
          <div className="px-3 py-2 text-[13px] text-muted-foreground">
            {translate(
              'components.settings.instructionFiles.remoteWorkspace',
              'This workspace is on a remote host. Edit its instruction files in a terminal there.'
            )}
          </div>
        ) : workspace.host === 'unresolved' ? (
          <div className="px-3 py-2 text-[13px] text-muted-foreground">
            {translate(
              'components.settings.instructionFiles.unresolvedWorkspace',
              'Still working out where this workspace runs; its files will appear once known.'
            )}
          </div>
        ) : workspace.host === 'ambiguous' ? (
          <div className="px-3 py-2 text-[13px] text-muted-foreground">
            {translate(
              'components.settings.instructionFiles.ambiguousWorkspace',
              'This folder spans local and remote repos, so its host cannot be decided. Edit its files from a terminal.'
            )}
          </div>
        ) : null}
        {shown.map((file) => {
          const label = statusLabel(file)
          const editable =
            file.status === 'loaded' ||
            (file.status === 'missing' && drafts[file.path] !== undefined)
          return (
            <div key={file.path} className="border-t border-border first:border-t-0">
              <div className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
                <Badge variant="secondary">{file.scope}</Badge>
                {drafts[file.path] !== undefined ? (
                  <span className="text-xs text-muted-foreground">
                    {translate('components.settings.instructionFiles.unsaved', 'unsaved')}
                  </span>
                ) : null}
                {editable ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setOpenPath(openPath === file.path ? null : file.path)}
                  >
                    {openPath === file.path
                      ? translate('components.settings.instructionFiles.close', 'Close')
                      : translate('components.settings.instructionFiles.open', 'Open')}
                  </Button>
                ) : file.status === 'missing' ? (
                  <Button type="button" size="xs" variant="ghost" onClick={() => startFile(file)}>
                    {translate('components.settings.instructionFiles.createGlobal', 'Create')}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">{label}</span>
                )}
              </div>
              {file.detail ? (
                <p className="px-3 pb-2 text-xs text-destructive">{file.detail}</p>
              ) : file.note ? (
                <p className="px-3 pb-2 text-xs text-muted-foreground">{file.note}</p>
              ) : null}
              {openPath === file.path ? (
                <div className="space-y-2 border-t border-border bg-card px-3 py-2">
                  <Textarea
                    aria-label={file.path}
                    rows={10}
                    className="font-mono text-xs"
                    value={draftOf(file)}
                    onChange={(event) => setDraft(file, event.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={saving || draftOf(file) === file.content}
                      onClick={() => void save(file)}
                    >
                      {translate('components.settings.instructionFiles.save', 'Save file')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={drafts[file.path] === undefined}
                      onClick={() => {
                        clearDraft(file.path)
                        if (file.status === 'missing') {
                          setOpenPath(null)
                        }
                      }}
                    >
                      {translate('components.settings.instructionFiles.revert', 'Revert')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}
