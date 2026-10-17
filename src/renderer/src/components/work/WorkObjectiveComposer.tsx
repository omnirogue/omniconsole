import { useSyncExternalStore, type ReactNode } from 'react'
import { Check, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { SESSION_PREP_ROUTING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AGENT_TEMPLATE_DEFAULT_ID } from '../../../../shared/agent-templates'
import {
  SESSION_PREP_MAX_REQUEST_CHARS,
  SESSION_PREP_RPC,
  type SessionPrepRequestResult
} from '../../../../shared/session-prep-types'
import { SessionPrepStatus } from '../native-chat/SessionPrepStatus'
import { noteSessionPrepBatch } from '../native-chat/session-prep-composer-state'
import { dispatchWorkspace, type WorkDispatchProject } from './work-dispatch-workspace'
import {
  newWorkObjective,
  workObjectives,
  updateWorkObjectives,
  subscribeWorkObjectives,
  submitWorkObjectives
} from './work-objective-state'

/** Every explicit row is its own objective; Reverse Prompting may split only inside that row. */
export function WorkObjectiveComposer({
  project,
  agentTemplateId,
  sourceWorktreeId,
  children
}: {
  project?: WorkDispatchProject
  agentTemplateId: string | null
  sourceWorktreeId?: string
  children: ReactNode
}): React.JSX.Element {
  const profileId = useAppStore((state) => state.activeOrcaProfileId)
  const routingMode = useAppStore((state) => state.settings?.dispatchRoutingMode ?? 'live')
  const paneKey = `need-speed:${profileId ?? 'default'}:${project?.folderId ?? 'work'}`
  const draftKey = JSON.stringify([paneKey, sourceWorktreeId ?? null])
  const state = useSyncExternalStore(subscribeWorkObjectives, () => workObjectives(draftKey))
  const updateRows = (rows: typeof state.rows) =>
    updateWorkObjectives(draftKey, (value) => ({ ...value, rows }))
  const pending = state.rows.some((row) => row.text.trim() && !row.batchId)
  const dispatch = async () => {
    let workspace: ReturnType<typeof dispatchWorkspace> | undefined
    let capability: Promise<void> | undefined
    const checkProfile = () => {
      if (useAppStore.getState().activeOrcaProfileId !== profileId) {
        throw new Error(
          translate(
            'needSpeed.profileChanged',
            'Return to the original profile to retry this prompt.'
          )
        )
      }
    }
    const checkCapability = () =>
      (capability ??= (async () => {
        checkProfile()
        const status = await callRuntimeRpc<RuntimeStatus>({ kind: 'local' }, 'status.get', {})
        if (!status.capabilities?.includes(SESSION_PREP_ROUTING_RUNTIME_CAPABILITY)) {
          throw new Error(
            translate(
              'needSpeed.updateRequired',
              'Update OmniConsole on this computer to use Need Speed. No prompts were submitted.'
            )
          )
        }
      })())
    await submitWorkObjectives(
      draftKey,
      async (row) => {
        await checkCapability()
        checkProfile()
        workspace ??= dispatchWorkspace(project, sourceWorktreeId)
        const prepared = await workspace
        if (!prepared.ok) {
          throw new Error(prepared.message)
        }
        return {
          requestId: row.id,
          text: row.text.trim(),
          source: {
            worktreeId: prepared.id,
            paneKey,
            agent: 'codex',
            entryPoint: 'need-speed',
            routingMode
          },
          context: '',
          ...(agentTemplateId && agentTemplateId !== AGENT_TEMPLATE_DEFAULT_ID
            ? { agentTemplateId }
            : {}),
          ...(project ? { defaultFolder: project.folderId } : {})
        }
      },
      async (request) => {
        await checkCapability()
        checkProfile()
        const accepted = await callRuntimeRpc<SessionPrepRequestResult>(
          { kind: 'local' },
          SESSION_PREP_RPC.request,
          request
        )
        noteSessionPrepBatch(paneKey)
        return accepted
      }
    )
  }

  return (
    <section
      className="space-y-3"
      aria-label={translate('needSpeed.prompts', 'Independent prompts')}
    >
      {state.storageError ? (
        <p role="alert" className="text-xs text-destructive">
          {state.storageError}
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void dispatch()
        }}
        aria-busy={state.sending}
        className="space-y-3"
      >
        {state.rows.map((row, index) => (
          <div key={row.id} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={row.id} className="text-sm font-medium">
                {translate('needSpeed.promptNumber', 'Prompt {{number}}', { number: index + 1 })}
              </label>
              {row.batchId ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Check className="size-3.5" aria-hidden />
                  {translate('needSpeed.accepted', 'Accepted')}
                </span>
              ) : !row.request && state.rows.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={state.sending}
                  aria-label={translate('needSpeed.removePrompt', 'Remove prompt {{number}}', {
                    number: index + 1
                  })}
                  onClick={() => updateRows(state.rows.filter((entry) => entry.id !== row.id))}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
            <Textarea
              id={row.id}
              value={row.text}
              rows={3}
              maxLength={SESSION_PREP_MAX_REQUEST_CHARS}
              placeholder={translate('needSpeed.promptPlaceholder', 'What outcome do you want?')}
              readOnly={state.sending || Boolean(row.request)}
              aria-invalid={Boolean(row.error)}
              aria-describedby={row.error ? `${row.id}-error` : undefined}
              onChange={(event) =>
                updateRows(
                  state.rows.map((entry) =>
                    entry.id === row.id
                      ? { ...entry, text: event.target.value, error: undefined }
                      : entry
                  )
                )
              }
            />
            {row.error ? (
              <p id={`${row.id}-error`} role="alert" className="text-xs text-destructive">
                {row.error}
              </p>
            ) : null}
          </div>
        ))}
        <fieldset disabled={state.sending} className="max-w-xs">
          {children}
        </fieldset>
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={state.sending || state.rows.length >= 20}
            onClick={() => updateRows([...state.rows, newWorkObjective()])}
          >
            <Plus className="size-3.5" aria-hidden />
            {translate('needSpeed.addPrompt', 'Add prompt')}
          </Button>
          <Button type="submit" disabled={state.sending || !pending}>
            {state.sending
              ? translate('needSpeed.sending', 'Submitting…')
              : state.rows.some((row) => row.error)
                ? translate('needSpeed.retry', 'Retry unfinished')
                : translate('needSpeed.start', 'Start work')}
          </Button>
        </div>
      </form>
      {state.rows.some((row) => row.batchId) ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={state.sending}
          onClick={() => {
            const unfinished = state.rows.filter((row) => !row.batchId)
            updateRows(unfinished.length ? unfinished : [newWorkObjective()])
          }}
        >
          {translate('needSpeed.clearAccepted', 'Clear accepted prompts')}
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {translate(
          'needSpeed.retryHelp',
          'Each prompt starts independently. Retrying keeps accepted work and resends only unfinished prompts.'
        )}
      </p>
      <div aria-live="polite">
        <SessionPrepStatus
          paneKey={paneKey}
          draft=""
          setDraft={(text) => updateRows([...state.rows, { ...newWorkObjective(), text }])}
        />
      </div>
    </section>
  )
}
