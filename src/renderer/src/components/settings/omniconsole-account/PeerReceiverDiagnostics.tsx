import { useEffect, useState } from 'react'
import { Radio, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../../../shared/runtime-terminal-contracts'
import { translate as t } from '@/i18n/i18n'
import { ReceiverResponse, receiverLabel, type PeerReceiverStatus } from './peer-receiver-status'

function ReceiverInspection({ terminal }: { terminal: string }) {
  const [status, setStatus] = useState<PeerReceiverStatus>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    void callRuntimeRpc({ kind: 'local' }, 'terminal.peerInboxStatus', { terminal })
      .then((value) => {
        const parsed = ReceiverResponse.safeParse(value)
        if (!parsed.success) {
          throw new Error('Receiving state could not be verified.')
        }
        if (live) {
          setStatus(parsed.data.receiver)
        }
      })
      .catch(() => {
        if (live) {
          setError(
            t(
              'inbox.receiverUnavailable',
              'Receiving state unavailable. The runtime may be disconnected or may not support this check.'
            )
          )
        }
      })
      .finally(() => {
        if (live) {
          setLoading(false)
        }
      })
    return () => {
      live = false
    }
  }, [terminal, revision])
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p role={error ? 'alert' : 'status'} className="text-sm font-medium">
          {loading
            ? t('inbox.receiverChecking', 'Checking receiver')
            : error || receiverLabel(status)}
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => setRevision((n) => n + 1)}
        >
          <RefreshCw className={loading ? 'animate-spin' : ''} />
          {t('inbox.refresh', 'Refresh')}
        </Button>
      </div>
      {!loading && !error && status && (
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          {status.enrollment && (
            <>
              <div>
                <dt className="text-muted-foreground">{t('inbox.project', 'Project')}</dt>
                <dd className="break-all">{status.enrollment.projectId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('inbox.task', 'Existing task ID')}</dt>
                <dd className="break-all">{status.enrollment.taskId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t('inbox.receiverEndpoint', 'Enrolled conversation')}
                </dt>
                <dd className="break-all">{status.enrollment.peerSessionId}</dd>
              </div>
            </>
          )}
          {status.lastPendingCheckAt !== undefined && (
            <div>
              <dt className="text-muted-foreground">
                {t('inbox.receiverLastCheck', 'Last successful pending check')}
              </dt>
              <dd>{new Date(status.lastPendingCheckAt).toLocaleString()}</dd>
            </div>
          )}
          {status.pending && (
            <div>
              <dt className="text-muted-foreground">
                {t('inbox.receiverPending', 'Pending at last check')}
              </dt>
              <dd>{status.pending.pending}</dd>
            </div>
          )}
          {!!status.consecutiveFailures && (
            <div>
              <dt className="text-muted-foreground">
                {t('inbox.receiverFailures', 'Consecutive failed checks')}
              </dt>
              <dd>{status.consecutiveFailures}</dd>
            </div>
          )}
          {status.nextCheckAt !== undefined && (
            <div>
              <dt className="text-muted-foreground">
                {t('inbox.receiverRetry', 'Scheduled retry')}
              </dt>
              <dd>{new Date(status.nextCheckAt).toLocaleTimeString()}</dd>
            </div>
          )}
        </dl>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          'inbox.receiverEvidenceHelp',
          'This inspects the receiver without consuming or acknowledging messages. An active receiver or queued hint does not prove that the model read a message. Verify automatic reception while working and while idle separately.'
        )}
      </p>
      {!loading && !error && !status && (
        <p className="text-xs text-muted-foreground">
          {t(
            'inbox.receiverSetupHelp',
            'Use your AI’s existing enrollment flow for an authorized task and its exact conversation. Automatic reception depends on the installed provider adapter; do not select another conversation as a fallback.'
          )}
        </p>
      )}
    </div>
  )
}

function ReceiverControls() {
  const [terminals, setTerminals] = useState<RuntimeTerminalSummary[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    setError('')
    void callRuntimeRpc<RuntimeTerminalListResult>({ kind: 'local' }, 'terminal.list', {
      requireFreshPtyLiveness: true
    })
      .then((result) => {
        if (live) {
          setTerminals(result.terminals.filter((item) => !!item.agentIdentity))
        }
      })
      .catch(() => {
        if (live) {
          setError(
            t(
              'inbox.receiverListError',
              'AI conversations could not be loaded. Retry when the runtime is available.'
            )
          )
        }
      })
    return () => {
      live = false
    }
  }, [revision])
  return (
    <div className="space-y-3 pt-3">
      {error ? (
        <div role="alert" className="text-sm">
          {error}
          <Button variant="ghost" onClick={() => setRevision((n) => n + 1)}>
            {t('inbox.retry', 'Retry')}
          </Button>
        </div>
      ) : (
        <>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger
              className="w-full sm:max-w-lg"
              aria-label={t('inbox.yourAI', 'Your AI conversation')}
            >
              <SelectValue placeholder={t('inbox.chooseAI', 'Choose an open AI conversation')} />
            </SelectTrigger>
            <SelectContent>
              {terminals.map((terminal) => (
                <SelectItem key={terminal.handle} value={terminal.handle}>
                  {terminal.title ?? terminal.agentIdentity} · {terminal.worktreePath}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected && <ReceiverInspection key={selected} terminal={selected} />}
          {!selected && (
            <p className="text-xs text-muted-foreground">
              {t(
                'inbox.receiverChooseHelp',
                'Select the exact AI conversation to inspect. Signing in or opening Inbox does not attach an automatic receiver.'
              )}
            </p>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Diagnostics for the AI receiver behind peer messages: which open conversation is enrolled
 * and whether it is listening. Inspection only — it never sends, binds or acknowledges.
 * Lives with the OmniConsole account because the receiver runs under that sign-in.
 */
export function PeerReceiverDiagnostics() {
  const [open, setOpen] = useState(false)
  return (
    <section className="space-y-2 border-t border-border/60 pt-5" data-peer-receiver-diagnostics>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Radio />
        {t('inbox.receiverPanel', 'AI receiving status')}
      </Button>
      {open && (
        <div className="max-h-72 overflow-y-auto scrollbar-sleek pl-1">
          <ReceiverControls />
        </div>
      )}
    </section>
  )
}
