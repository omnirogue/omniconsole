import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import type {
  BrowserCleanupMode,
  BrowserCleanupReport,
  BrowserCleanupRow
} from '../../../../shared/browser-cleanup'

export function BrowserCleanupControl(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<BrowserCleanupReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reopened, setReopened] = useState<string[]>([])
  const closed = report?.rows.filter((row) => row.outcome === 'closed') ?? []
  const eligible = report?.rows.filter((row) => row.eligible).length ?? 0
  const finished = report?.reopenPath !== undefined

  async function review(mode: BrowserCleanupMode): Promise<void> {
    setBusy(true)
    setError(null)
    setReport(null)
    setReopened([])
    try {
      setReport(
        await callRuntimeRpc<BrowserCleanupReport>({ kind: 'local' }, 'browser.cleanup', {
          action: 'preview',
          mode
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function apply(): Promise<void> {
    if (!report) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      setReport(
        await callRuntimeRpc<BrowserCleanupReport>({ kind: 'local' }, 'browser.cleanup', {
          action: 'apply',
          token: report.token
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      // A failed reply cannot authorize a second close using the old preview.
      setReport(null)
    } finally {
      setBusy(false)
    }
  }

  async function reopen(row: BrowserCleanupRow): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await callRuntimeRpc({ kind: 'local' }, 'browser.tabCreate', {
        url: row.url,
        worktree: `id:${row.worktreeId}`,
        profileId: row.profileId ?? undefined
      })
      setReopened((ids) => [...ids, row.pageId])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div
        id="browser-cleanup"
        className="flex items-center justify-between gap-4 rounded-md border p-4"
      >
        <div>
          <p className="text-sm font-medium">
            {translate('browser.cleanup.title', 'Clean up browser pages')}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'browser.cleanup.description',
              'Review pages on this computer and close those you no longer need.'
            )}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setOpen(true)
            void review('unused')
          }}
        >
          {translate('browser.cleanup.review', 'Review pages')}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value)
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {translate('browser.cleanup.title', 'Clean up browser pages')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'browser.cleanup.detail',
                'This computer’s OmniConsole pages. Pinned pages, active downloads, detected form content, and pages we cannot check stay open. A reopen list saves URLs, not unsaved work.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void review('unused')}>
              {translate('browser.cleanup.unused', 'Review unused pages')}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void review('all')}>
              {translate('browser.cleanup.all', 'Review all pages')}
            </Button>
          </div>
          {busy && (
            <p role="status" className="text-sm text-muted-foreground">
              {translate('browser.cleanup.working', 'Checking browser pages…')}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {report && (
            <>
              <p className="text-sm">
                {finished
                  ? translate('browser.cleanup.closed', 'Pages closed: {{count}}.', {
                      count: closed.length
                    })
                  : translate(
                      'browser.cleanup.ready',
                      'Ready to close: {{count}}. Each page will be checked again.',
                      { count: eligible }
                    )}
              </p>
              <div className="max-h-72 overflow-y-auto scrollbar-sleek rounded-md border">
                {report.rows.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">
                    {translate('browser.cleanup.empty', 'No browser pages on this computer.')}
                  </p>
                )}
                {report.rows.map((row) => (
                  <div
                    key={row.pageId}
                    className="flex items-center gap-3 border-b p-3 last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{row.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{row.url}</p>
                      <p className="text-xs text-muted-foreground">{row.reason}</p>
                    </div>
                    {row.outcome === 'closed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || reopened.includes(row.pageId)}
                        onClick={() => void reopen(row)}
                      >
                        {reopened.includes(row.pageId)
                          ? translate('browser.cleanup.reopened', 'Reopened')
                          : translate('browser.cleanup.reopen', 'Reopen')}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {report.reopenPath && (
                <p className="break-all text-xs text-muted-foreground">
                  {translate('browser.cleanup.saved', 'Reopen list saved: {{path}}', {
                    path: report.reopenPath
                  })}
                </p>
              )}
            </>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              {translate('browser.cleanup.done', 'Done')}
            </Button>
            {!finished && (
              <Button disabled={busy || !report || eligible === 0} onClick={() => void apply()}>
                {translate('browser.cleanup.close', 'Close reviewed pages ({{count}})', {
                  count: eligible
                })}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
