import { useEffect, useState } from 'react'
import { Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  createCompanySessionFolder,
  resolveCompanySessionFolder,
  startCompanySession
} from '@/lib/start-company-session'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useWorkAgentCapabilities } from '@/hooks/useWorkAgentCapabilities'
import type { TuiAgent } from '../../../../shared/tui-agent'

type SessionCompany = { slug: string; name: string }
type SessionDomain = { id?: string | null; name: string } | null

/**
 * Company → department → a session, from the page that shows the work. The
 * folder is decided in Settings ahead of time, so this asks only for the agent
 * and a first message.
 */
/** The catalog's label for an agent; the legacy label helpers are ratcheted out of new callers. */
function agentLabelOf(id: TuiAgent): string {
  return getAgentCatalog().find((entry) => entry.id === id)?.label ?? id
}

export function CompanyStartSession({
  company,
  domain,
  label,
  size = 'xs'
}: {
  company: SessionCompany
  domain: SessionDomain
  label?: string
  size?: 'xs' | 'sm'
}): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const defaultAgent = settings?.defaultTuiAgent
  const availability = useWorkAgentCapabilities(null)
  const agents = availability.usable.map((entry) => entry.id)
  const [open, setOpen] = useState(false)
  const [chosenAgent, setAgent] = useState<TuiAgent>(
    defaultAgent && defaultAgent !== 'blank' ? defaultAgent : 'claude'
  )
  // Why: settings may load after mount or disable the chosen agent; derive the
  // effective choice from the enabled list instead of adjusting state in an effect.
  const agent: TuiAgent = agents.includes(chosenAgent)
    ? chosenAgent
    : defaultAgent && defaultAgent !== 'blank' && agents.includes(defaultAgent)
      ? defaultAgent
      : (agents[0] ?? 'claude')
  const [note, setNote] = useState('')
  const [folder, setFolder] = useState('')
  const [missing, setMissing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    let live = true
    void resolveCompanySessionFolder({ company, domain }).then((path) => {
      if (live) {
        setFolder(path)
      }
    })
    return () => {
      live = false
    }
    // Why: the folder depends on the saved settings and the chosen department only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, company.slug, domain?.id, settings?.companyWorkRoot, settings?.companyFolders])

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      const available = (await availability.refresh([agent])).find(
        (entry) => entry.id === agent && entry.status === 'usable'
      )
      const model = (available?.models.find((entry) => entry.isDefault) ?? available?.models[0])?.id
      if (!model) {
        toast.error(
          translate(
            'conversations.agentBecameUnavailable',
            'This agent or model is no longer available. Refresh and choose another.'
          )
        )
        return
      }
      const result = await startCompanySession({
        company,
        domain,
        agent,
        note,
        launchPreferences: { model },
        viewModePreference: 'chat'
      })
      if (result.ok) {
        setOpen(false)
        setNote('')
        setMissing(null)
        return
      }
      if (result.reason === 'folder-missing') {
        setMissing(result.path)
        return
      }
      toast.error(result.message)
    } finally {
      setBusy(false)
    }
  }

  const createFolderThenStart = async (path: string): Promise<void> => {
    setBusy(true)
    const created = await createCompanySessionFolder(path)
    setBusy(false)
    if (!created.ok) {
      toast.error(created.message)
      return
    }
    setMissing(null)
    await start()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size={size} variant="outline">
          <Play className="size-3.5" />
          {label ?? translate('companySessions.startWork', 'Start Work')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 space-y-3">
        <div className="space-y-1">
          <Label>{translate('companySessions.folder', 'Folder')}</Label>
          <p className="break-all font-mono text-xs text-muted-foreground">{folder || '—'}</p>
          <Button
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={() => openSettingsTarget({ pane: 'backoffice', repoId: null })}
          >
            {translate('companySessions.changeInSettings', 'Change in Settings')}
          </Button>
        </div>
        {missing ? (
          <div className="space-y-2 rounded-md border border-dashed p-2">
            <p className="text-xs text-muted-foreground">
              {translate(
                'companySessions.folderMissing',
                'That folder does not exist yet, so no session was started.'
              )}
            </p>
            <Button size="xs" disabled={busy} onClick={() => void createFolderThenStart(missing)}>
              {translate('companySessions.createFolder', 'Create {{path}}', { path: missing })}
            </Button>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="company-session-agent">
            {translate('companySessions.agent', 'Agent')}
          </Label>
          <Select value={agent} onValueChange={(value) => setAgent(value as TuiAgent)}>
            <SelectTrigger
              id="company-session-agent"
              size="sm"
              aria-label={translate('companySessions.agent', 'Agent')}
            >
              <SelectValue>{agentLabelOf(agent)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {agents.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {agentLabelOf(candidate)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="company-session-note">
            {translate('companySessions.note', 'First message (optional)')}
          </Label>
          <Textarea
            id="company-session-note"
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <Button size="sm" disabled={busy} onClick={() => void start()}>
          {busy
            ? translate('companySessions.starting', 'Starting…')
            : translate('companySessions.startWork', 'Start Work')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
