import { useEffect, useState } from 'react'
import type { OmnisiTeamStatus } from '../../../../shared/omnisi-team'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { SearchableSetting } from './SearchableSetting'

export function OmnisiTeamSettings(): React.JSX.Element | null {
  const api = window.api?.omnisiTeam
  const [status, setStatus] = useState<OmnisiTeamStatus>({ enabled: false, connected: false })
  const [server, setServer] = useState('')
  const [key, setKey] = useState('')
  const [pasted, setPasted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!api) {
      return
    }
    let active = true
    const refresh = (): void => {
      void api
        .status()
        .then((next) => {
          if (active) {
            setStatus(next)
          }
        })
        .catch(() => {
          if (active) {
            setError(translate('omnisiTeam.readError', 'Could not read the OmniSI connection.'))
          }
        })
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [api])
  if (!api) {
    return null
  }
  async function run(work: () => Promise<OmnisiTeamStatus>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      setStatus(await work())
    } catch {
      setError(
        translate(
          'omnisiTeam.actionError',
          'Could not finish. Check your server, team key and OS keychain. Disconnect to clean up a partial connection.'
        )
      )
    } finally {
      setBusy(false)
      setKey('')
      if (pasted) {
        setServer('')
      }
    }
  }
  return (
    <SearchableSetting
      title={translate('omnisiTeam.title', 'OmniSI team')}
      description={translate(
        'omnisiTeam.description',
        'Experimental · connect your AI team on this computer.'
      )}
      keywords={[
        ...translateSearchKeyword('omnisiTeam.keywordOmnisi', 'omnisi'),
        ...translateSearchKeyword('omnisiTeam.keywordTeam', 'team'),
        ...translateSearchKeyword('omnisiTeam.keywordConnection', 'connection'),
        ...translateSearchKeyword('omnisiTeam.keywordServer', 'server'),
        ...translateSearchKeyword('omnisiTeam.keywordKey', 'key'),
        ...translateSearchKeyword('omnisiTeam.keywordSend', 'send'),
        ...translateSearchKeyword('omnisiTeam.keywordBlueprint', 'blueprint')
      ]}
      className="space-y-3 py-2"
      id="experimental-omnisi-team"
    >
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="omnisi-team-enabled">
          {translate('omnisiTeam.enabledLabel', 'OmniSI team (experimental)')}
        </Label>
        <Switch
          id="omnisi-team-enabled"
          checked={status.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => {
            void run(() => api!.enable(enabled))
          }}
        />
      </div>
      {status.enabled ? (
        <div className="space-y-3">
          {status.connected ? (
            <>
              <p className="text-sm">
                {translate('omnisiTeam.connectedTeam', 'Connected team: {{team}}', {
                  team: status.team ?? ''
                })}
              </p>
              <p className="break-all text-xs text-muted-foreground">{status.server}</p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'omnisiTeam.connectedHint',
                  "Open AI panes can receive work sent from OmniSI. Reopen existing panes to load the team's tools. Human approval steps remain in each request."
                )}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'omnisiTeam.stepOne',
                  "1. In OmniSI, open your team's connection card and copy its connection."
                )}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setPasted(!pasted)
                  setServer('')
                  setKey('')
                }}
              >
                {pasted
                  ? translate('omnisiTeam.enterSeparately', 'Enter URL and key separately')
                  : translate('omnisiTeam.pasteConnection', 'Paste connection')}
              </Button>
              <Label htmlFor="omnisi-team-server">
                {pasted
                  ? translate('omnisiTeam.connectionJson', 'Connection JSON')
                  : translate('omnisiTeam.serverUrl', 'Server URL')}
              </Label>
              <Input
                id="omnisi-team-server"
                type={pasted ? 'password' : 'url'}
                autoComplete="off"
                spellCheck={false}
                value={server}
                onChange={(event) => setServer(event.target.value)}
                placeholder={
                  pasted
                    ? translate('omnisiTeam.pastePlaceholder', 'Paste the connection from OmniSI')
                    : translate('omnisiTeam.serverPlaceholder', 'https://app.omnisi.ai/mcp')
                }
                disabled={busy}
              />
              {!pasted ? (
                <>
                  <Label htmlFor="omnisi-team-key">
                    {translate('omnisiTeam.teamKey', 'Team key')}
                  </Label>
                  <Input
                    id="omnisi-team-key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    placeholder={translate('omnisiTeam.keyPlaceholder', 'osc1.…')}
                    disabled={busy}
                  />
                </>
              ) : null}
              <Button
                disabled={busy || !server || (!pasted && !key)}
                onClick={() => {
                  void run(() => api!.connect(server, key))
                }}
              >
                {translate('omnisiTeam.stepTwo', '2. Connect team')}
              </Button>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {translate(
              'omnisiTeam.toolsNote',
              'Team tools: Claude, Codex, Gemini and Grok on this computer. Muse, WSL and remote hosts need separate setup; their credentials are never copied.'
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              void run(() => api!.disconnect())
            }}
          >
            {translate('omnisiTeam.disconnect', 'Disconnect')}
          </Button>
        </div>
      ) : null}
      {error || status.error ? (
        <p role="alert" className="text-sm text-destructive">
          {error || status.error}
        </p>
      ) : null}
    </SearchableSetting>
  )
}
