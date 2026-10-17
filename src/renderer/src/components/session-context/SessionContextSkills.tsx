import { useEffect, useState } from 'react'
import { Check, Sparkles } from 'lucide-react'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { skillDiscoveryRequestFor } from '@/lib/project-launch-skills'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../shared/skills'
import type { SessionContextAttachment } from '../../../../shared/session-context-attachments'

export function SessionContextSkills({
  worktreeId,
  chosen,
  busy,
  onAdd,
  onError
}: {
  worktreeId: string | null
  chosen: ReadonlySet<string>
  busy: boolean
  onAdd: (items: SessionContextAttachment[]) => Promise<void>
  onError: (message: string) => void
}) {
  const [skills, setSkills] = useState<DiscoveredSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [query, setQuery] = useState('')
  const hostId = useAppStore((state) =>
    worktreeId ? getExecutionHostIdForWorktree(state, worktreeId) : 'local'
  )
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const { runtime, target } = skillDiscoveryRequestFor(worktreeId, hostId)
    void callRuntimeRpc<SkillDiscoveryResult>(runtime, 'skills.discover', target, {
      timeoutMs: 15_000
    })
      .then((result) => {
        if (!cancelled) {
          setSkills(result.skills)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(
            translate(
              'sessionContext.skillsFailed',
              'Skills could not be loaded from this session’s computer.'
            )
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [worktreeId, hostId, retry])
  const matches = skills
    .filter((skill) =>
      `${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(query.toLowerCase())
    )
    .slice(0, 60)
  return (
    <Command shouldFilter={false} className="h-auto border">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={translate('sessionContext.searchSkills', 'Search installed skills…')}
      />
      <CommandList className="max-h-56">
        {loading && (
          <p role="status" className="p-2 text-xs text-muted-foreground">
            {translate('sessionContext.loadingSkills', 'Loading skills…')}
          </p>
        )}
        {error && (
          <div className="p-2 text-xs">
            <p role="alert" className="text-destructive">
              {error}
            </p>
            <Button size="xs" variant="link" onClick={() => setRetry((value) => value + 1)}>
              {translate('sessionContext.retry', 'Retry')}
            </Button>
          </div>
        )}
        {!loading && !error && !matches.length && (
          <p className="p-2 text-xs text-muted-foreground">
            {translate('sessionContext.noSkills', 'No matching skills installed.')}
          </p>
        )}
        {matches.map((skill) => {
          const id = `skill:${hostId}:${skill.skillFilePath}`
          const Icon = chosen.has(id) ? Check : Sparkles
          return (
            <CommandItem
              key={id}
              value={id}
              disabled={busy || !hostId || chosen.has(id)}
              onSelect={() => {
                void onAdd([
                  {
                    id,
                    kind: 'skill',
                    title: skill.name,
                    uri: skill.skillFilePath,
                    hostId: hostId ?? 'local'
                  }
                ]).catch((err) => onError(err instanceof Error ? err.message : String(err)))
              }}
            >
              <Icon className="size-3.5" />
              <span className="min-w-0">
                <span className="block truncate">{skill.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {skill.description ?? skill.sourceLabel}
                </span>
              </span>
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}
