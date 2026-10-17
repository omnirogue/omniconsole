import type React from 'react'
import { useEffect, useMemo, useState } from 'react'

import { translate } from '@/i18n/i18n'
import { getCompanyFolderHome } from '@/lib/company-folder-home'
import { companiesApi, useCompaniesRead } from '@/components/companies/companies-client'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import {
  DEFAULT_COMPANY_WORK_ROOT,
  isValidFolderSetting,
  resolveCompanyFolder
} from '../../../../shared/company-folders'

type CompanyRow = { slug: string; name: string }

function useCompanyRows(overrides: Record<string, string>): {
  rows: CompanyRow[]
  unavailable: boolean
} {
  const org = useCompaniesRead(() => companiesApi().org(), 'org')
  return useMemo(() => {
    const rows = new Map<string, CompanyRow>()
    for (const company of org.data?.companies ?? []) {
      const slug = company.slug ?? company.id
      if (slug) {
        rows.set(slug, { slug, name: company.name ?? slug })
      }
    }
    // Why: a saved override must stay editable even when the estate read fails.
    for (const slug of Object.keys(overrides)) {
      if (!rows.has(slug)) {
        rows.set(slug, { slug, name: slug })
      }
    }
    return { rows: [...rows.values()], unavailable: Boolean(org.error) }
  }, [org.data, org.error, overrides])
}

function CompanyFolderRow({
  company,
  workRoot,
  overrides,
  home,
  onSave
}: {
  company: CompanyRow
  workRoot: string
  overrides: Record<string, string>
  home: string
  onSave: (overrides: Record<string, string>) => void
}): React.JSX.Element {
  const saved = overrides[company.slug] ?? ''
  const [draft, setDraft] = useState(saved)
  const [error, setError] = useState<string | null>(null)
  const [savedSeen, setSavedSeen] = useState(saved)
  if (saved !== savedSeen) {
    // Why: a save elsewhere (Reset, another device) replaces the draft in the same
    // render, not a frame later — the pattern React documents for prop-driven state.
    setSavedSeen(saved)
    setDraft(saved)
    setError(null)
  }
  const fallback = resolveCompanyFolder({
    workRoot,
    company,
    home
  })
  const commit = (): void => {
    const value = draft.trim()
    if (!value) {
      const { [company.slug]: _removed, ...rest } = overrides
      setError(null)
      onSave(rest)
      return
    }
    if (!isValidFolderSetting(value)) {
      setError(
        translate(
          'companyFolders.invalidFolder',
          'Use an absolute path or one starting with ~/ — nothing was saved.'
        )
      )
      return
    }
    setError(null)
    onSave({ ...overrides, [company.slug]: value })
  }
  return (
    <div className="flex flex-col gap-1.5" data-company-folder={company.slug}>
      <Label htmlFor={`company-folder-${company.slug}`}>{company.name}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={`company-folder-${company.slug}`}
          value={draft}
          placeholder={fallback}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit()
            }
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!saved && !draft.trim()}
          onClick={() => {
            setDraft('')
            setError(null)
            const { [company.slug]: _removed, ...rest } = overrides
            onSave(rest)
          }}
        >
          {translate('companyFolders.reset', 'Reset')}
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="font-mono text-xs text-muted-foreground">{saved || fallback}</p>
      )}
    </div>
  )
}

/**
 * Settings → Backoffice → Company folders: where each company's work lives on
 * this machine, decided ahead of time so "Start session" never has to ask.
 */
export function CompanyFoldersSettingsPane(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const overrides = useMemo(() => settings?.companyFolders ?? {}, [settings?.companyFolders])
  const workRoot = settings?.companyWorkRoot?.trim() || DEFAULT_COMPANY_WORK_ROOT
  const [home, setHome] = useState('')
  const [rootDraft, setRootDraft] = useState(workRoot)
  const [rootError, setRootError] = useState<string | null>(null)
  const { rows, unavailable } = useCompanyRows(overrides)
  useEffect(() => {
    let live = true
    void getCompanyFolderHome().then((value) => {
      if (live) {
        setHome(value)
      }
    })
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    setRootDraft(workRoot)
    setRootError(null)
  }, [workRoot])

  const commitRoot = (): void => {
    const value = rootDraft.trim() || DEFAULT_COMPANY_WORK_ROOT
    if (!isValidFolderSetting(value)) {
      setRootError(
        translate(
          'companyFolders.invalidFolder',
          'Use an absolute path or one starting with ~/ — nothing was saved.'
        )
      )
      return
    }
    setRootError(null)
    void updateSettings({ companyWorkRoot: value })
  }

  return (
    <div className="flex flex-col gap-5" data-testid="company-folders-pane">
      <div className="flex flex-col gap-2">
        <Label htmlFor="company-work-root">
          {translate('companyFolders.workRoot', 'Work root')}
        </Label>
        <Input
          id="company-work-root"
          value={rootDraft}
          placeholder={DEFAULT_COMPANY_WORK_ROOT}
          spellCheck={false}
          onChange={(event) => setRootDraft(event.target.value)}
          onBlur={commitRoot}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitRoot()
            }
          }}
        />
        {rootError ? (
          <p className="text-xs text-destructive">{rootError}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {translate(
              'companyFolders.workRootHelp',
              'Each company defaults to <work root>/<Company name>, and each department to a folder inside it. Only folders under this root, or under a company folder set here, can be created from the Companies page.'
            )}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label>{translate('companyFolders.title', 'Company folders')}</Label>
          {unavailable ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'companyFolders.companiesUnavailable',
                'The estate’s company list is unavailable, so only companies you have already configured are listed.'
              )}
            </p>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate('companyFolders.noCompanies', 'No companies to configure yet.')}
          </p>
        ) : (
          rows.map((company) => (
            <CompanyFolderRow
              key={company.slug}
              company={company}
              workRoot={workRoot}
              overrides={overrides}
              home={home}
              onSave={(next) => void updateSettings({ companyFolders: next })}
            />
          ))
        )}
      </div>
    </div>
  )
}
