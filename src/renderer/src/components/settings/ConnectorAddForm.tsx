import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { ConnectorAccount, McpConnectorsApi } from '../../../../shared/mcp-connectors'
import { validateConnectorDefinition } from '../../../../shared/mcp-connectors'
import {
  OMNI_CONSOLE_MCP_NAME,
  OMNI_CONSOLE_MCP_URL,
  OMNIROGUE_MCP_NAME,
  OMNIROGUE_MCP_URL,
  OMNIROGUE_UNIFIED_MCP_ENDPOINTS,
  OMNISI_MCP_NAME,
  OMNISI_MCP_URL
} from '../../../../shared/omni-console-mcp-ledger-headers'

const QUICK_CONNECT_PRESETS = [
  { name: OMNIROGUE_MCP_NAME, url: OMNIROGUE_MCP_URL },
  { name: OMNISI_MCP_NAME, url: OMNISI_MCP_URL },
  { name: OMNI_CONSOLE_MCP_NAME, url: OMNI_CONSOLE_MCP_URL }
] as const

type ConnectorAddFormProps = {
  accounts: ConnectorAccount[]
  api: McpConnectorsApi
  busy: boolean
  run: (operation: () => Promise<void>) => Promise<void>
  onRefresh: () => Promise<void>
  onAdded: () => void
  initialAccountId: string
}

export function ConnectorAddForm({
  accounts,
  api,
  busy,
  run,
  onRefresh,
  onAdded,
  initialAccountId
}: ConnectorAddFormProps): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([initialAccountId])
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'http' | 'stdio'>('http')
  const [endpoint, setEndpoint] = useState('')
  const [args, setArgs] = useState('[]')
  return (
    <form
      className="space-y-3 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          const definition = validateConnectorDefinition({
            name: name.trim(),
            transport,
            ...(transport === 'http'
              ? { url: endpoint.trim() }
              : { command: endpoint.trim(), args: JSON.parse(args) })
          })
          if (!selected.length) {
            throw new Error(
              translate('connectors.selectAccount', 'Select at least one agent account.')
            )
          }
          const failed: string[] = []
          for (const id of selected) {
            try {
              await api.add(id, definition)
            } catch {
              failed.push(accounts.find((a) => a.id === id)?.label ?? id)
            }
          }
          await onRefresh()
          if (failed.length) {
            setSelected(
              accounts
                .filter((account) => failed.includes(account.label))
                .map((account) => account.id)
            )
            throw new Error(
              `${translate('connectors.partialFailure', 'Could not add to these accounts:')} ${failed.join(', ')}. ${translate('connectors.partialSuccess', 'Successful accounts keep their connector; retry only the failed accounts.')}`
            )
          }
          setName('')
          setEndpoint('')
          onAdded()
        })
      }}
    >
      <h3 className="text-sm font-semibold">{translate('connectors.add', 'Add connector')}</h3>
      <div
        className="space-y-2.5 rounded-lg border border-primary/30 bg-primary/5 p-3.5"
        data-testid="omnirogue-unified-connector-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              {translate('connectors.featured', '#1 Featured')}
            </span>
            <p className="text-xs font-semibold text-foreground">
              {translate('connectors.unifiedTitle', 'OmniRogue & OmniSI Unified MCP')}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={busy || !selected.length}
            onClick={() => {
              void run(async () => {
                if (!selected.length) {
                  throw new Error(
                    translate('connectors.selectAccount', 'Select at least one agent account.')
                  )
                }
                for (const id of selected) {
                  for (const item of OMNIROGUE_UNIFIED_MCP_ENDPOINTS) {
                    const definition = validateConnectorDefinition({
                      name: item.name,
                      transport: 'http',
                      url: item.url
                    })
                    await api.add(id, definition)
                  }
                }
                await onRefresh()
                onAdded()
              })
            }}
          >
            {translate('connectors.connectUnified', 'Connect Unified MCP')}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {translate(
            'connectors.unifiedIntro',
            'Auto-provisioned when your OmniRogue account is connected. Provides'
          )}{' '}
          <span className="font-medium text-foreground">
            {translate(
              'connectors.unifiedTools',
              'OmniRogue Image/Video Generation, Unified Credits, Evolve Super Intelligence, Discover, and Decisions'
            )}
          </span>{' '}
          {translate('connectors.unifiedScope', 'across all local and SSH-relay coding agents.')}
        </p>
      </div>
      <div className="space-y-2 rounded-md border bg-muted/40 p-3">
        <p className="text-xs font-medium">
          {translate('connectors.quickConnect', 'Quick Connect OmniSI & OmniConsole MCP')}
        </p>
        <div className="flex flex-wrap gap-2">
          {QUICK_CONNECT_PRESETS.map((preset) => (
            <Button
              key={preset.name}
              type="button"
              variant="outline"
              size="sm"
              title={preset.url}
              disabled={busy}
              aria-pressed={name === preset.name && transport === 'http' && endpoint === preset.url}
              onClick={() => {
                // Why fill instead of add: the account choice below still decides where it goes.
                setName(preset.name)
                setTransport('http')
                setEndpoint(preset.url)
              }}
            >
              {preset.name === OMNIROGUE_MCP_NAME
                ? translate('connectors.quickConnectOmniRogue', 'OmniRogue Creative & Credits MCP')
                : preset.name === OMNISI_MCP_NAME
                  ? translate('connectors.quickConnectOmnisi', 'OmniSI Shared Tools MCP')
                  : translate('connectors.quickConnectOmniConsole', 'OmniConsole Estate MCP')}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'connectors.quickConnectHint',
            'Fills in the server below. Choose agent accounts, then Add connector and use Sign in.'
          )}
        </p>
      </div>
      <Label htmlFor="connector-name">{translate('connectors.name', 'Name')}</Label>
      <Input
        id="connector-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
        required
      />
      <Label htmlFor="connector-transport">
        {translate('connectors.transport', 'Connection type')}
      </Label>
      <Select
        value={transport}
        onValueChange={(value) => {
          setTransport(value as 'http' | 'stdio')
          setEndpoint('')
        }}
        disabled={busy}
      >
        <SelectTrigger id="connector-transport">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="http">{translate('connectors.http', 'Server URL')}</SelectItem>
          <SelectItem value="stdio">{translate('connectors.stdio', 'Local command')}</SelectItem>
        </SelectContent>
      </Select>
      <Label htmlFor="connector-endpoint">
        {transport === 'http'
          ? translate('connectors.url', 'Server URL')
          : translate('connectors.command', 'Executable')}
      </Label>
      <Input
        id="connector-endpoint"
        value={endpoint}
        onChange={(e) => setEndpoint(e.target.value)}
        disabled={busy}
        required
      />
      {transport === 'stdio' && (
        <>
          <Label htmlFor="connector-args">
            {translate('connectors.args', 'Arguments (JSON array)')}
          </Label>
          <Input
            id="connector-args"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">
            {translate(
              'connectors.execHint',
              'This command runs when the agent connects. Example arguments: ["--port", "3000"].'
            )}
          </p>
        </>
      )}
      <fieldset className="space-y-2" disabled={busy}>
        <legend className="mb-2 text-sm font-medium">
          {translate('connectors.useAccounts', 'Use with agent accounts')}
        </legend>
        {accounts.map((account) => (
          <label key={account.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={selected.includes(account.id)}
              disabled={busy || !account.available}
              onCheckedChange={(checked) =>
                setSelected((current) =>
                  checked ? [...current, account.id] : current.filter((id) => id !== account.id)
                )
              }
            />
            {account.label}
          </label>
        ))}
      </fieldset>
      <Button type="submit" disabled={busy || !selected.length}>
        {translate('connectors.add', 'Add connector')}
      </Button>
    </form>
  )
}
