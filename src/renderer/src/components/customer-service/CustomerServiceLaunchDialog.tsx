import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useWorkAgentCapabilities } from '@/hooks/useWorkAgentCapabilities'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import {
  createCompanySessionFolder,
  resolveCompanySessionFolder,
  startCompanySession
} from '@/lib/start-company-session'
import { useAppStore } from '@/store'
import type { CustomerServicePreview } from '../../../../shared/customer-service-launch'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'

const domain = { name: 'Customer Service' }
export function CustomerServiceLaunchDialog(): React.JSX.Element {
  const hydrated = useAppStore((state) => state.hydrationSucceeded && state.persistedUIReady)
  const scope = useAppStore(selectConsoleAccountScope)
  const defaultAgent = useAppStore((state) => state.settings?.defaultTuiAgent)
  const available = useWorkAgentCapabilities(null).usable.map((entry) => entry.id)
  const [chosen, setChosen] = useState<TuiAgent | null>(null)
  const agent =
    chosen && available.includes(chosen)
      ? chosen
      : defaultAgent && defaultAgent !== 'blank' && available.includes(defaultAgent)
        ? defaultAgent
        : available[0]
  const [id, setId] = useState<string | null>(null)
  const [preview, setPreview] = useState<CustomerServicePreview | null>(null)
  const [message, setMessage] = useState('')
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const api = window.api.customerServiceLaunch

  useEffect(() => {
    if (!hydrated || !api) {
      return
    }
    let disposed = false
    const show = (value: string | null) => {
      if (value && !disposed && !inFlight.current) {
        setId(value)
      }
    }
    const unsubscribe = api.onOpen(show)
    void api.consumePending().then(show)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [api, hydrated])

  useEffect(() => {
    if (!id || !api) {
      return
    }
    let disposed = false
    setPreview(null)
    setMessage('')
    setFolder('')
    void api
      .preview(id)
      .then(async (result) => {
        if (disposed) {
          return
        }
        if (!result.ok) {
          setMessage(result.error.message)
          return
        }
        setPreview(result.data)
        const path = await resolveCompanySessionFolder({
          company: result.data.launch.company,
          domain
        })
        if (!disposed) {
          setFolder(path)
        }
      })
      .catch(() => {
        if (!disposed) {
          setMessage(
            translate(
              'customerService.unavailable',
              'The launch preview could not be loaded. Reopen it from Customer Service.'
            )
          )
        }
      })
    return () => {
      disposed = true
    }
  }, [api, id, scope])

  async function recordReceipt(current: CustomerServicePreview, tabId?: string): Promise<boolean> {
    if (!api) {
      return false
    }
    const result = await api.receipt({
      previewKey: current.previewKey,
      ...(tabId ? { tabId } : {})
    })
    if (!result.ok) {
      setMessage(result.error.message)
      return false
    }
    toast.success(
      translate('customerService.started', 'Customer Service session started on this computer.')
    )
    setId(null)
    return true
  }

  async function start(): Promise<void> {
    if (!api || !preview || !agent || inFlight.current) {
      return
    }
    const current = preview
    const launchScope = selectConsoleAccountScope(useAppStore.getState())
    inFlight.current = true
    setBusy(true)
    setMessage('')
    try {
      if (current.localState === 'receipt-pending') {
        await recordReceipt(current)
        return
      }
      if (current.localState !== 'ready' || !folder) {
        return
      }
      const created = await createCompanySessionFolder(folder)
      if (!created.ok) {
        setMessage(created.message)
        return
      }
      if (selectConsoleAccountScope(useAppStore.getState()) !== launchScope) {
        return
      }
      const permitted = await api.begin({ previewKey: current.previewKey })
      if (!permitted.ok) {
        setMessage(permitted.error.message)
        return
      }
      setPreview({ ...current, localState: 'unverifiable' })
      if (selectConsoleAccountScope(useAppStore.getState()) !== launchScope) {
        return
      }
      let tabId: string | undefined
      let earlyReceipt: Promise<unknown> | undefined
      const result = await startCompanySession({
        company: permitted.data.company,
        domain,
        agent,
        note: permitted.data.brief,
        conversationLauncher: true,
        expectedAccountScope: launchScope,
        onSessionCreated: (value) => {
          tabId = value
          earlyReceipt = api
            .receipt({ previewKey: current.previewKey, tabId: value })
            .catch(() => undefined)
        }
      })
      tabId = result.ok ? (result.tabId ?? tabId) : tabId
      if (!result.ok || !tabId) {
        setMessage(
          translate(
            'customerService.unknown',
            'The launch result is unverified. Check your sessions before starting new work.'
          )
        )
        return
      }
      setPreview({ ...current, localState: 'receipt-pending' })
      await earlyReceipt
      await recordReceipt(current, tabId)
    } catch {
      setMessage(
        translate(
          'customerService.unknown',
          'The launch result is unverified. Check your sessions before starting new work.'
        )
      )
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const state = preview?.localState
  return (
    <Dialog
      open={Boolean(id)}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setId(null)
        }
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {translate('customerService.title', 'Start Customer Service session')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'customerService.description',
              'Review the selected issues, then start work on this computer with your signed-in account.'
            )}
          </DialogDescription>
        </DialogHeader>
        {preview && (
          <>
            <p className="text-sm">
              {preview.launch.company.name} · {preview.launch.ticket_ids.length}{' '}
              {translate('customerService.issues', 'issues')}
            </p>
            <p className="text-xs text-muted-foreground break-all">{folder}</p>
            <pre className="max-h-64 overflow-auto scrollbar-sleek whitespace-pre-wrap rounded-md border bg-muted p-3 text-xs">
              {preview.launch.brief}
            </pre>
            {state === 'ready' && (
              <Select
                value={agent ?? ''}
                onValueChange={(value) => setChosen(value as TuiAgent)}
                disabled={busy}
              >
                <SelectTrigger aria-label={translate('companySessions.agent', 'Agent')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {available.map((value) => (
                    <SelectItem key={value} value={value}>
                      {getAgentCatalog().find((item) => item.id === value)?.label ?? value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {state === 'unverifiable' && (
              <p className="text-sm">
                {translate(
                  'customerService.unverifiable',
                  'This launch was already attempted on a computer. Check the existing session; reopening this link will not start another.'
                )}
              </p>
            )}
            {state === 'launched' && (
              <p className="text-sm">
                {translate(
                  'customerService.alreadyStarted',
                  'This set of issues already has a session.'
                )}
              </p>
            )}
          </>
        )}
        {message && (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setId(null)}>
            {translate('common.close', 'Close')}
          </Button>
          {(state === 'ready' || state === 'receipt-pending') && (
            <Button
              disabled={busy || (state === 'ready' && (!agent || !folder))}
              onClick={() => void start()}
            >
              {busy
                ? translate('companySessions.starting', 'Starting…')
                : state === 'receipt-pending'
                  ? translate('customerService.retryReceipt', 'Record session receipt')
                  : translate('customerService.startHere', 'Start on this computer')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
