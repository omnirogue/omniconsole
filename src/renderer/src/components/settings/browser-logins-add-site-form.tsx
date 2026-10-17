import type React from 'react'
import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { companiesApi, useCompaniesRead } from '@/components/companies/companies-client'
import type { AddSiteRequest } from '../../../../shared/browser-logins-contract'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { browserLoginsErrorLine } from './browser-logins-format'

// Why: a controlled input needs a string, but `expected_identity` is optional on
// the wire — kept as `''` in the form and omitted from the request at submit time.
type FormState = Omit<AddSiteRequest, 'expected_identity'> & { expected_identity: string }

const EMPTY: FormState = {
  profile_id: '',
  service: '',
  url: '',
  company_id: '',
  expected_identity: ''
}

/** Add a new shared site to the rail: id, service, its URL, the company it belongs to. */
export function BrowserLoginsAddSiteForm({
  onAdd
}: {
  onAdd: (request: AddSiteRequest) => Promise<{ ok: boolean; error?: unknown }>
}): React.JSX.Element {
  const org = useCompaniesRead(() => companiesApi().org(), 'org')
  const [form, setForm] = useState<FormState>(EMPTY)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const set = (patch: Partial<FormState>): void => setForm((prev) => ({ ...prev, ...patch }))

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    const identity = form.expected_identity.trim()
    const request: AddSiteRequest = {
      ...form,
      expected_identity: identity.length > 0 ? identity : undefined
    }
    void onAdd(request).then((result) => {
      setSubmitting(false)
      if (result.ok) {
        setForm(EMPTY)
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border/60 p-3"
      data-testid="browser-logins-add-site-form"
    >
      <h4 className="text-sm font-medium">{translate('browserLogins.addSite', 'Add site')}</h4>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="browser-logins-profile-id">
            {translate('browserLogins.field.profileId', 'Profile id')}
          </Label>
          <Input
            id="browser-logins-profile-id"
            value={form.profile_id}
            onChange={(event) => set({ profile_id: event.target.value })}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="browser-logins-service">
            {translate('browserLogins.field.service', 'Service')}
          </Label>
          <Input
            id="browser-logins-service"
            value={form.service}
            onChange={(event) => set({ service: event.target.value })}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="browser-logins-url">
            {translate('browserLogins.field.url', 'Site URL')}
          </Label>
          <Input
            id="browser-logins-url"
            type="url"
            value={form.url}
            onChange={(event) => set({ url: event.target.value })}
            placeholder={translate('browserLogins.field.urlPlaceholder', 'https://')}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="browser-logins-company">
            {translate('browserLogins.field.company', 'Company')}
          </Label>
          <Select value={form.company_id} onValueChange={(value) => set({ company_id: value })}>
            <SelectTrigger id="browser-logins-company">
              <SelectValue
                placeholder={translate('browserLogins.field.selectCompany', 'Select a company')}
              />
            </SelectTrigger>
            <SelectContent>
              {(org.data?.companies ?? []).map((company) => {
                const id = company.id ?? company.slug ?? ''
                return id ? (
                  <SelectItem key={id} value={id}>
                    {company.name ?? id}
                  </SelectItem>
                ) : null
              })}
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-2 flex flex-col gap-1.5">
          <Label htmlFor="browser-logins-identity">
            {translate('browserLogins.field.expectedIdentity', 'Expected identity (optional)')}
          </Label>
          <Input
            id="browser-logins-identity"
            value={form.expected_identity}
            onChange={(event) => set({ expected_identity: event.target.value })}
            placeholder={translate('browserLogins.field.expectedIdentityHelp', 'e.g. Sal')}
          />
        </div>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {browserLoginsErrorLine(error)}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting} className="w-fit" size="sm">
        {submitting
          ? translate('browserLogins.adding', 'Adding…')
          : translate('browserLogins.addSiteSubmit', 'Add site')}
      </Button>
    </form>
  )
}
