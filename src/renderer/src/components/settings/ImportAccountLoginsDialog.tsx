import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

type Profile = { path: string; email?: string | null }

export function ImportAccountLoginsDialog({
  provider,
  model,
  onClose
}: {
  provider: 'claude' | 'codex'
  model: AccountsPaneSectionModel
  onClose: () => void
}): React.JSX.Element {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    void callRuntimeRpc<{ directories: Profile[] }>({ kind: 'local' }, 'accounts.importExisting', {
      provider,
      preview: true
    })
      .then((result) => {
        if (!disposed) {
          setProfiles(result.directories)
        }
      })
      .catch(() => {
        if (!disposed) {
          setError(
            translate(
              'settings.accountBalances.discoveryError',
              'Could not find saved logins. Try again.'
            )
          )
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false)
        }
      })
    return () => {
      disposed = true
    }
  }, [provider])
  const importSelected = async (): Promise<ProviderAccountsSnapshot> => {
    setSaving(true)
    try {
      const result = await callRuntimeRpc<{
        imported: number
        alreadyAdded: number
        needsAttention: number
        snapshot: ProviderAccountsSnapshot
      }>({ kind: 'local' }, 'accounts.importExisting', { provider, paths: [...selected] })
      toast.success(
        translate(
          'settings.accountBalances.importResult',
          '{{imported}} imported · {{existing}} already added · {{attention}} need sign-in',
          {
            imported: result.imported,
            existing: result.alreadyAdded,
            attention: result.needsAttention
          }
        )
      )
      onClose()
      return result.snapshot
    } finally {
      setSaving(false)
    }
  }
  const save = (): void => {
    if (provider === 'claude') {
      void model.runClaudeAccountAction('adding', async () => (await importSelected()).claude)
    } else {
      void model.runCodexAccountAction('adding', async () => (await importSelected()).codex)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) {
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate('settings.accountBalances.importTitle', 'Import {{provider}} logins', {
              provider: provider === 'claude' ? 'Claude' : 'Codex'
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'settings.accountBalances.importDescription',
              'Choose the saved logins you want in Settings. Duplicate identities are skipped; your default stays the same.'
            )}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {loading ? (
          <p className="text-sm text-muted-foreground">
            {translate('settings.accountBalances.finding', 'Finding saved logins…')}
          </p>
        ) : null}
        {!loading && !error && profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {translate(
              'settings.accountBalances.noneFound',
              'No saved logins found. Use Add Account to sign in.'
            )}
          </p>
        ) : null}
        <div className="max-h-80 space-y-1 overflow-y-auto scrollbar-sleek">
          {profiles.map((profile) => (
            <label
              key={profile.path}
              className="flex cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-accent"
            >
              <Checkbox
                disabled={saving}
                checked={selected.has(profile.path)}
                onCheckedChange={(checked) =>
                  setSelected((previous) => {
                    const next = new Set(previous)
                    if (checked === true) {
                      next.add(profile.path)
                    } else {
                      next.delete(profile.path)
                    }
                    return next
                  })
                }
              />
              <span className="min-w-0">
                <span className="block truncate text-sm">
                  {profile.email ??
                    translate('settings.accountBalances.unidentified', 'Saved login')}
                </span>
                <span className="block truncate text-xs text-muted-foreground" title={profile.path}>
                  {profile.path}
                </span>
              </span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {translate('settings.accountBalances.cancel', 'Cancel')}
          </Button>
          <Button disabled={loading || saving || selected.size === 0} onClick={save}>
            {saving
              ? translate('settings.accountBalances.importing', 'Importing…')
              : translate(
                  'settings.accountBalances.importSelected',
                  'Import selected ({{count}})',
                  { count: selected.size }
                )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
