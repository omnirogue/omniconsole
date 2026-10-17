import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { effortChoicesFor } from '../../../../shared/build-review-model-options'
import { launcherAccountLines } from '../sidebar/session-folders/new-conversation/launcher-account-lines'
import { useReadyPaneOptions } from './ready-pane-options'
import type { ReadyDraft, ReadyPaneDrafts } from '@/store/ready-pane-drafts'
import { translate } from '@/i18n/i18n'

const DEFAULT = '__default__'
export function ReadyPicker(props: {
  label: string
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  children: React.ReactNode
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {props.label}
      <Select
        value={props.value || DEFAULT}
        disabled={props.disabled}
        onValueChange={(value) => props.onChange(value === DEFAULT ? '' : value)}
      >
        <SelectTrigger size="sm" className="w-full text-foreground" aria-label={props.label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{props.children}</SelectContent>
      </Select>
    </label>
  )
}

export function ReadyPanePickers(props: {
  pane: ReadyPaneDrafts
  disabled: boolean
  onDraft: (patch: Partial<ReadyDraft>) => void
  onPane: (patch: Partial<ReadyPaneDrafts>) => void
}) {
  const folders = useAppStore((state) => state.folderWorkspaces)
  const worktrees = useAppStore((state) => state.worktreesByRepo)
  const options = useReadyPaneOptions(props.pane.workspace, props.pane.provider)
  const draft = props.pane.drafts[props.pane.provider]
  const model = draft.model ?? options.defaults.model ?? ''
  const effort = draft.effort ?? options.defaults.effort ?? ''
  const account = draft.account ?? options.defaultAccount
  const efforts = model ? effortChoicesFor(props.pane.provider, options.models, model) : []
  const workspaces = useMemo(
    () =>
      [
        ...folders.map((folder) => ({ id: `folder:${folder.id}`, label: folder.folderPath })),
        ...Object.values(worktrees)
          .flat()
          .map((worktree) => ({ id: worktree.id, label: worktree.path }))
      ].filter((row, index, rows) => rows.findIndex((other) => other.id === row.id) === index),
    [folders, worktrees]
  )
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <ReadyPicker
          label={translate('readyPane.model', 'Model')}
          value={model}
          disabled={props.disabled}
          onChange={(value) => props.onDraft({ model: value, effort: '' })}
        >
          <SelectItem value={DEFAULT}>
            {translate('readyPane.agentDefault', 'Agent default')}
          </SelectItem>
          {model && !options.models.some((row) => row.id === model) ? (
            <SelectItem value={model}>{model}</SelectItem>
          ) : null}
          {options.models.map((row) => (
            <SelectItem key={row.id} value={row.id}>
              {row.label}
            </SelectItem>
          ))}
        </ReadyPicker>
        <ReadyPicker
          label={translate('readyPane.effort', 'Effort')}
          value={effort}
          disabled={props.disabled || !model}
          onChange={(value) => props.onDraft({ effort: value })}
        >
          <SelectItem value={DEFAULT}>
            {translate('readyPane.agentDefault', 'Agent default')}
          </SelectItem>
          {effort && !efforts.some((row) => row.value === effort) ? (
            <SelectItem value={effort}>{effort}</SelectItem>
          ) : null}
          {efforts
            .filter((row) => row.value !== '__agent-default__')
            .map((row) => (
              <SelectItem key={row.value} value={row.value}>
                {row.label}
              </SelectItem>
            ))}
        </ReadyPicker>
      </div>
      {options.stale ? (
        <p className="text-xs text-muted-foreground">
          {translate('readyPane.staleModels', 'Model list may be out of date. Verified on Send.')}
        </p>
      ) : null}
      <ReadyPicker
        label={translate('readyPane.account', 'Account')}
        value={account}
        disabled={props.disabled}
        onChange={(value) => props.onDraft({ account: value })}
      >
        {!options.rows.some((row) => row.choiceId === account) ? (
          <SelectItem value={account}>
            {translate('readyPane.cachedAccount', 'Saved account · verified on Send')}
          </SelectItem>
        ) : null}
        {options.rows.map((row) => (
          <SelectItem key={row.choiceId} value={row.choiceId} disabled={row.state === 'signed-out'}>
            <span className="flex flex-col">
              <span>
                {row.email ?? translate('readyPane.systemAccount', 'System account')}
                {row.detail ? ` · ${row.detail}` : ''}
              </span>
              <span className="text-xs text-muted-foreground">
                {launcherAccountLines(row).join(' · ')}
              </span>
            </span>
          </SelectItem>
        ))}
      </ReadyPicker>
      <ReadyPicker
        label={translate('readyPane.workspace', 'Workspace')}
        value={props.pane.workspace}
        disabled={props.disabled}
        onChange={(workspace) => props.onPane({ workspace })}
      >
        <SelectItem value={DEFAULT}>{translate('readyPane.workFolder', 'Work folder')}</SelectItem>
        {props.pane.workspace && !workspaces.some((row) => row.id === props.pane.workspace) ? (
          <SelectItem value={props.pane.workspace}>
            {translate('readyPane.unavailableWorkspace', 'Saved workspace · currently unavailable')}
          </SelectItem>
        ) : null}
        {workspaces.map((row) => (
          <SelectItem key={row.id} value={row.id}>
            {row.label}
          </SelectItem>
        ))}
      </ReadyPicker>
      <ReadyPicker
        label={translate('readyPane.freshLocation', 'After Send, place the next ready pane')}
        value={props.pane.fresh}
        disabled={props.disabled}
        onChange={(fresh) => props.onPane({ fresh: fresh === 'tray' ? 'tray' : 'slot' })}
      >
        <SelectItem value="slot">
          {translate('readyPane.sameSlot', 'Same slot, if there is room')}
        </SelectItem>
        <SelectItem value="tray">{translate('readyPane.tray', 'Tray')}</SelectItem>
      </ReadyPicker>
    </>
  )
}
