import { useWorkFolders, useWorkFoldersScope } from '@/components/companies/use-work-folders'
import { companiesErrorMessage } from '@/components/companies/companies-client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { routineDepartmentSlug } from '../../../../../shared/routine-mac-dependence'
import { routineTeamCopy as copy } from './routine-team-copy'
import { useEffect, useState } from 'react'

function scopeKey(row: { id?: string | null; slug?: string | null; name?: string | null }): string {
  return String(row.id ?? row.slug ?? row.name ?? '')
}

export function RoutineTeamScopePicker({
  onChange
}: {
  onChange: (scope: string) => void
}): React.JSX.Element {
  const folders = useWorkFolders(useWorkFoldersScope())
  // Selections are remembered by id, so a reloaded folder tree that no longer holds
  // them simply reads as "nothing chosen" instead of pointing at a different row.
  const [companyKey, setCompanyKey] = useState('')
  const [departmentKey, setDepartmentKey] = useState('')
  const companies = (folders.data?.companies ?? []).filter(
    (c) => !c.status || c.status === 'active'
  )
  const company = companies.find((c) => scopeKey(c) === companyKey)
  const domains = company?.domains ?? []
  const selected = domains.find((d) => scopeKey(d) === departmentKey)
  const departmentSlug = routineDepartmentSlug(selected?.name ?? '')
  const valid = !!company?.slug && /^[a-z0-9-]+$/.test(company.slug) && !!departmentSlug
  const scope = valid ? `${company.slug}/${departmentSlug}` : ''
  useEffect(() => {
    onChange(scope)
  }, [scope, onChange])
  return (
    <div className="space-y-3">
      {folders.error ? (
        <div role="alert" className="text-xs text-destructive">
          {translate(
            'routineToTeam.foldersFailed',
            'Could not load companies and departments: {{message}}',
            { message: companiesErrorMessage(folders.error) }
          )}
          <Button variant="ghost" size="xs" onClick={folders.reload}>
            {copy.foldersRetry()}
          </Button>
        </div>
      ) : null}
      <div className="space-y-1">
        <Label>{copy.company()}</Label>
        <Select
          value={company ? companyKey : ''}
          onValueChange={(value) => {
            setCompanyKey(value)
            setDepartmentKey('')
          }}
          disabled={folders.loading}
        >
          <SelectTrigger aria-label={copy.company()}>
            <SelectValue placeholder={copy.choose()} />
          </SelectTrigger>
          <SelectContent>
            {companies.map((c) => (
              <SelectItem key={scopeKey(c)} value={scopeKey(c)}>
                {c.name ?? c.slug}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>{copy.department()}</Label>
        <Select
          value={selected ? departmentKey : ''}
          disabled={!company}
          onValueChange={setDepartmentKey}
        >
          <SelectTrigger aria-label={copy.department()}>
            <SelectValue placeholder={copy.choose()} />
          </SelectTrigger>
          <SelectContent>
            {domains.map((d) => (
              <SelectItem key={scopeKey(d)} value={scopeKey(d)}>
                {d.name ?? d.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {!valid ? <p className="text-xs text-muted-foreground">{copy.badScope()}</p> : null}
    </div>
  )
}
