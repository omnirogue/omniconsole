import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate as t } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { UpNextAgentDraft } from '../../../../../shared/up-next-types'
import {
  WORK_PLAN_LAYOUTS_RPC,
  WORK_PLAN_LAYOUT_NAME_MAX,
  type WorkPlanLayout
} from '../../../../../shared/work-plan-layouts'

export type SavedWorkflow = {
  id: string
  name: string
  executable: boolean
  stage: UpNextAgentDraft
}
export type SavedWorkflowSource = {
  list(): SavedWorkflow[] | Promise<SavedWorkflow[]>
  save(entry: SavedWorkflow): void | Promise<unknown>
  rename?(id: string, name: string): void | Promise<unknown>
  delete?(id: string): void | Promise<unknown>
}

export const persistedWorkflowSource: SavedWorkflowSource = {
  list: async () => {
    const { layouts } = await callRuntimeRpc<{ layouts: WorkPlanLayout[] }>(
      { kind: 'local' },
      WORK_PLAN_LAYOUTS_RPC.list,
      {}
    )
    return layouts.map((entry) => ({ ...entry, executable: true }))
  },
  save: ({ name, stage }) =>
    callRuntimeRpc({ kind: 'local' }, WORK_PLAN_LAYOUTS_RPC.save, { name, stage }),
  rename: (id, name) =>
    callRuntimeRpc({ kind: 'local' }, WORK_PLAN_LAYOUTS_RPC.rename, { id, name }),
  delete: (id) => callRuntimeRpc({ kind: 'local' }, WORK_PLAN_LAYOUTS_RPC.delete, { id })
}

export function SavedWorkflowMenu({
  stage,
  onUse,
  disabled,
  source = persistedWorkflowSource
}: {
  stage: UpNextAgentDraft
  onUse: (stage: UpNextAgentDraft) => void
  disabled: boolean
  source?: SavedWorkflowSource
}) {
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([])
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const generation = useRef(Symbol())
  const writing = useRef(false)

  useEffect(() => {
    const current = Symbol()
    generation.current = current
    setBusy(false)
    writing.current = false
    setLoaded(false)
    setFailed(false)
    Promise.resolve()
      .then(() => source.list())
      .then((entries) => {
        if (current !== generation.current) {
          return
        }
        setWorkflows(entries.filter((entry) => entry.executable))
        setLoaded(true)
      })
      .catch(() => {
        if (current === generation.current) {
          setFailed(true)
        }
      })
    return () => {
      generation.current = Symbol()
    }
  }, [source])

  async function mutate(write: () => void | Promise<unknown>): Promise<void> {
    if (writing.current) {
      return
    }
    writing.current = true
    const current = generation.current
    setBusy(true)
    setFailed(false)
    let failure = false
    try {
      await write()
    } catch {
      failure = true
    }
    try {
      const entries = await source.list()
      if (current !== generation.current) {
        return
      }
      setWorkflows(entries.filter((entry) => entry.executable))
      setLoaded(true)
    } catch {
      failure = true
    } finally {
      if (current === generation.current) {
        writing.current = false
        setBusy(false)
        setFailed(failure)
        if (!failure) {
          setName('')
          setEditing(null)
        }
      }
    }
  }

  return (
    <fieldset disabled={disabled || busy} className="space-y-2" aria-busy={busy}>
      <p className="text-xs text-muted-foreground">
        {t(
          'upNext.savedWorkflow.singleStage',
          'Saved workflows contain one agent stage. Multi-stage layouts are not supported yet.'
        )}
      </p>
      {failed && (
        <p role="alert">
          {t('upNext.savedWorkflow.error', 'Could not load or change saved workflows. Try again.')}
        </p>
      )}
      <ul aria-label={t('upNext.savedWorkflow.label', 'Saved workflow')}>
        {loaded &&
          workflows.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => onUse(structuredClone(entry.stage))}>
                {entry.name}
              </Button>
              {source.rename && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing({ id: entry.id, name: entry.name })}
                >
                  {t('upNext.savedWorkflow.rename', 'Rename')}
                </Button>
              )}
              {source.delete && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void mutate(() => source.delete!(entry.id))}
                >
                  {t('upNext.savedWorkflow.delete', 'Delete')}
                </Button>
              )}
            </li>
          ))}
      </ul>
      {loaded && !workflows.length && (
        <p>{t('upNext.savedWorkflow.empty', 'No saved workflows yet.')}</p>
      )}
      {editing && (
        <div className="space-y-2">
          <label>
            {t('upNext.savedWorkflow.renamePrompt', 'New workflow name')}
            <Input
              value={editing.name}
              maxLength={WORK_PLAN_LAYOUT_NAME_MAX}
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            />
          </label>
          <Button
            size="sm"
            disabled={!editing.name.trim()}
            onClick={() => void mutate(() => source.rename!(editing.id, editing.name.trim()))}
          >
            {t('upNext.savedWorkflow.renameSave', 'Save name')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
            {t('upNext.savedWorkflow.cancel', 'Cancel')}
          </Button>
        </div>
      )}
      <label>
        {t('upNext.savedWorkflow.savePrompt', 'Save this stage as…')}
        <Input
          value={name}
          maxLength={WORK_PLAN_LAYOUT_NAME_MAX}
          placeholder={t('upNext.savedWorkflow.placeholder', 'Workflow name')}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <Button
        size="sm"
        disabled={disabled || !loaded || !name.trim()}
        onClick={() =>
          void mutate(() =>
            source.save({
              id: crypto.randomUUID(),
              name: name.trim(),
              executable: true,
              stage: structuredClone(stage)
            })
          )
        }
      >
        {t('upNext.savedWorkflow.save', 'Save stage')}
      </Button>
    </fieldset>
  )
}
