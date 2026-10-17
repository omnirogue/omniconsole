import { ConnectorAddForm } from './ConnectorAddForm'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type {
  ConnectorAccount,
  ConnectorAction,
  ConnectorStatus,
  ConnectorSummary
} from '../../../../shared/mcp-connectors'

export function ConnectorsPane(): React.JSX.Element {
  const api = window.api.mcpConnectors
  const [accounts, setAccounts] = useState<ConnectorAccount[]>([])
  const [accountId, setAccountId] = useState('codex:default')
  const [servers, setServers] = useState<ConnectorSummary[]>([])
  const [statuses, setStatuses] = useState<Record<string, ConnectorStatus>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const inFlight = useRef(false)

  useEffect(() => {
    if (!api) {
      return
    }
    let cancelled = false
    void api
      .accounts()
      .then((value) => {
        if (!cancelled) {
          setAccounts(value)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(translate('connectors.loadError', 'Unable to load accounts on this computer.'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [api])

  useEffect(() => {
    let cancelled = false
    setServers([])
    setStatuses({})
    setRemoving(null)
    setError('')
    if (!api) {
      return
    }
    setBusy(true)
    void api
      .list(accountId)
      .then((value) => {
        if (!cancelled) {
          setServers(value)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setError(String(error))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [accountId, api])

  const operations = {
    async run(operation: () => Promise<void>): Promise<void> {
      if (busy || inFlight.current || !api) {
        return
      }
      inFlight.current = true
      setBusy(true)
      setError('')
      setNotice('')
      try {
        await operation()
      } catch (error) {
        setError(String(error))
      } finally {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  const action = (server: ConnectorSummary, action: ConnectorAction): void => {
    const updateConnector = async (): Promise<void> => {
      const status = await api!.action(accountId, server.name, action)
      if (action === 'remove') {
        setServers(await api!.list(accountId))
        setRemoving(null)
      } else {
        setStatuses((current) => ({ ...current, [server.name]: status }))
      }
    }
    void operations.run(updateConnector)
  }

  const refresh = async (): Promise<void> => {
    setServers(await api!.list(accountId))
    setStatuses({})
  }

  if (!api) {
    return (
      <p className="text-sm text-muted-foreground">
        {translate(
          'connectors.unsupported',
          'Update OmniConsole on this computer to manage connectors.'
        )}
      </p>
    )
  }

  const statusLabel = (server: ConnectorSummary): string => {
    if (!server.enabled) {
      return translate('connectors.disabled', 'Disabled')
    }
    switch (statuses[server.name] ?? 'configured') {
      case 'connected':
        return translate('connectors.connected', 'Connected')
      case 'signed-in':
        return translate('connectors.signedIn', 'Signed in · connection not verified')
      case 'needs-sign-in':
        return translate('connectors.needsSignIn', 'Sign-in required')
      case 'unavailable':
        return translate('connectors.unavailable', 'Connection unavailable')
      case 'configured':
        return translate('connectors.configured', 'Configured · connection not verified')
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        {translate(
          'connectors.scope',
          'Manage Claude and Codex connectors on this computer. Configure SSH and paired computers on their own OmniConsole host; WSL accounts inside their distro. Existing conversations may need to restart to use changes.'
        )}
      </p>
      <div className="space-y-2">
        <Label htmlFor="connector-account">
          {translate('connectors.account', 'Agent account')}
        </Label>
        <Select value={accountId} onValueChange={setAccountId} disabled={busy}>
          <SelectTrigger id="connector-account">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id} disabled={!account.available}>
                {account.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {busy && (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('connectors.working', 'Working… Complete browser sign-in if prompted.')}
        </p>
      )}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {translate('connectors.configuredTitle', 'Your connectors')}
          </h3>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void operations.run(refresh)}
          >
            {translate('connectors.refresh', 'Refresh')}
          </Button>
        </div>
        {!servers.length && !busy && (
          <p className="text-xs text-muted-foreground">
            {translate('connectors.empty', 'No account connectors configured. Add one below.')}
          </p>
        )}
        {servers.map((server) => (
          <div key={server.name} className="space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{server.name}</p>
                <p className="text-xs text-muted-foreground">{statusLabel(server)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !server.enabled}
                  onClick={() => action(server, 'check')}
                >
                  {translate('connectors.check', 'Check connection')}
                </Button>
                {server.transport === 'http' && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !server.enabled}
                      onClick={() => action(server, 'login')}
                    >
                      {translate('connectors.signIn', 'Sign in')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !server.enabled}
                      onClick={() => action(server, 'reconnect')}
                    >
                      {translate('connectors.reconnect', 'Reconnect')}
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setRemoving(server.name)}
                >
                  {translate('connectors.remove', 'Remove')}
                </Button>
              </div>
            </div>
            {removing === server.name && (
              <div className="flex items-center gap-2">
                <p className="text-xs">
                  {translate('connectors.confirmRemove', 'Remove from this account?')}
                </p>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() => action(server, 'remove')}
                >
                  {translate('connectors.remove', 'Remove')}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(null)}>
                  {translate('connectors.cancel', 'Cancel')}
                </Button>
              </div>
            )}
          </div>
        ))}
      </section>
      <ConnectorAddForm
        key={accountId}
        initialAccountId={accountId}
        accounts={accounts}
        api={api}
        busy={busy}
        run={operations.run}
        onRefresh={async () => {
          setServers(await api.list(accountId))
        }}
        onAdded={() =>
          setNotice(
            translate(
              'connectors.added',
              'Connector added. Use Sign in for servers that require OAuth.'
            )
          )
        }
      />
    </div>
  )
}
