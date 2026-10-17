import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAppStore } from '@/store'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import {
  useReadyPaneDrafts,
  loadReadyPaneDrafts,
  updateReadyPane,
  readySubmissionInFlight,
  emptyReadyPane
} from '@/store/ready-pane-drafts'
import type { ReadyDraft, ReadyPaneDrafts } from '@/store/ready-pane-drafts'
import { ReadyPanePickers } from './ReadyPanePickers'
import { useReadyPaneOptions } from './ready-pane-options'
import { sendReadyPane, recoverReadyPaneLaunches, reconcileReadyPane } from './ready-pane-launch'
import { translate } from '@/i18n/i18n'

const EMPTY = emptyReadyPane()
export function ReadyPaneLaunchObserver(): null {
  const scope = useAppStore(selectConsoleAccountScope)
  useEffect(() => {
    recoverReadyPaneLaunches(scope)
  }, [scope])
  return null
}

export default function ReadyPane({ paneId }: { paneId: string }): React.JSX.Element {
  const scope = useAppStore(selectConsoleAccountScope)
  const pane = useReadyPaneDrafts((state) => state.documents[scope]?.panes[paneId]) ?? EMPTY
  const storageError = useReadyPaneDrafts((state) => state.errors[scope])
  const options = useReadyPaneOptions(pane.workspace, pane.provider)
  useEffect(() => {
    loadReadyPaneDrafts(scope)
    if (!useReadyPaneDrafts.getState().documents[scope].panes[paneId]) {
      updateReadyPane(scope, paneId, (value) => value)
    }
  }, [scope, paneId])
  const busy = readySubmissionInFlight(pane.submission)
  const draft = pane.drafts[pane.provider]
  const updatePane = (patch: Partial<ReadyPaneDrafts>) => {
    updateReadyPane(scope, paneId, (value) => ({ ...value, ...patch }))
  }
  const updateDraft = (patch: Partial<ReadyDraft>) => {
    updateReadyPane(scope, paneId, (value) => ({
      ...value,
      drafts: { ...value.drafts, [value.provider]: { ...value.drafts[value.provider], ...patch } }
    }))
  }
  const send = () => {
    void sendReadyPane(scope, paneId, {
      ...draft,
      model: draft.model ?? options.defaults.model,
      effort: draft.effort ?? options.defaults.effort,
      account: draft.account ?? options.defaultAccount
    })
  }
  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto scrollbar-sleek p-3"
      data-ready-pane={paneId}
    >
      <Tabs
        value={pane.provider}
        onValueChange={(provider) =>
          updatePane({ provider: provider === 'codex' ? 'codex' : 'claude' })
        }
      >
        <TabsList className="w-full">
          <TabsTrigger value="claude" disabled={busy}>
            {translate('conversationLauncher.claude', 'Claude')}
          </TabsTrigger>
          <TabsTrigger value="codex" disabled={busy}>
            {translate('conversationLauncher.codex', 'Codex')}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <ReadyPanePickers pane={pane} disabled={busy} onDraft={updateDraft} onPane={updatePane} />
      <Textarea
        className="min-h-24 flex-1 resize-none"
        aria-label={translate('readyPane.prompt', 'Message')}
        placeholder={translate('readyPane.placeholder', 'What would you like to work on?')}
        value={draft.text}
        disabled={busy}
        onChange={(event) => updateDraft({ text: event.target.value })}
      />
      {storageError ? (
        <p role="alert" className="text-xs text-destructive">
          {storageError}
        </p>
      ) : null}
      {pane.submission ? (
        <div role="status" className="space-y-1 text-xs text-muted-foreground">
          <p>
            {pane.submission.status === 'validating'
              ? translate('readyPane.validating', 'Validating account, host and preferences…')
              : pane.submission.status === 'starting'
                ? translate(
                    'readyPane.starting',
                    'Starting · waiting for the session and prompt receipt…'
                  )
                : pane.submission.status === 'attached'
                  ? translate(
                      'readyPane.attached',
                      'Session attached · waiting for the prompt receipt…'
                    )
                  : pane.submission.error}
          </p>
          {pane.submission.status === 'uncertain' ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                reconcileReadyPane(scope, paneId)
              }}
            >
              {translate('readyPane.checkSession', 'Check for session')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !draft.text || Boolean(storageError)}
          onClick={() => updateDraft({ text: '' })}
        >
          {translate('readyPane.discard', 'Discard draft')}
        </Button>
        <Button
          size="sm"
          disabled={busy || !draft.text.trim() || Boolean(storageError)}
          onClick={send}
        >
          {pane.submission?.status === 'failed'
            ? translate('readyPane.retry', 'Retry')
            : translate('readyPane.send', 'Send')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate('readyPane.waitingCost', 'Draft saved. The agent starts only when you Send.')}
      </p>
    </div>
  )
}
