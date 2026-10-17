import type React from 'react'
import { translate } from '@/i18n/i18n'
import { companiesApi, useCompaniesRead } from '@/components/companies/companies-client'
import { EverybodysShelf } from './ToolShelfAdminPane'
import { CapabilityRows, accessApi, errorLine } from './tool-shelf-shared'

/**
 * The Tool Shelf: what the signed-in person may use through the estate gateway,
 * and — for the estate's super admins — everybody's shelf with the controls to change it.
 * Every answer comes from the hub through the console BFF, carried as the person;
 * this pane never decides authority, it only shows the hub's decision and asks for
 * a change the hub then judges again.
 */

function MyTools(): React.JSX.Element {
  const mine = useCompaniesRead(() => accessApi().mine(), 'access:mine')
  return (
    <section data-testid="tool-shelf-mine" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{translate('toolShelf.mineTitle', 'My tools')}</h3>
        {mine.data ? (
          <span className="text-xs text-muted-foreground">
            {translate('toolShelf.mineCount', '{{count}} capabilities as {{principal}}', {
              count: mine.data.count ?? mine.data.capabilities.length,
              principal: mine.data.principal
            })}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'toolShelf.mineHelp',
          'What the estate gateway lets you (and the agents you start) use. Read tools run freely; a write is real; anything marked "needs approval" waits for a named approver. Nothing here is a credential — the hub holds those.'
        )}
      </p>
      {mine.loading ? (
        <p className="text-sm text-muted-foreground">
          {translate('toolShelf.loading', 'Loading…')}
        </p>
      ) : null}
      {mine.error ? (
        <p className="text-sm text-destructive" role="alert">
          {errorLine(mine.error)}
        </p>
      ) : null}
      {mine.data ? <CapabilityRows capabilities={mine.data.capabilities} /> : null}
    </section>
  )
}

export function ToolShelfSettingsPane(): React.JSX.Element {
  const me = useCompaniesRead(() => companiesApi().me(), 'me')
  const isAdmin = me.data?.user?.role === 'admin'
  return (
    <div className="flex flex-col gap-6" data-testid="tool-shelf-pane">
      <div>
        <h2 className="text-base font-semibold">{translate('toolShelf.title', 'Tool Shelf')}</h2>
        <p className="text-xs text-muted-foreground">
          {translate(
            'toolShelf.subtitle',
            'One policy for people and agents: the hub resolves it, the gateway enforces it, this shelf shows it.'
          )}
        </p>
      </div>
      <MyTools />
      {isAdmin ? <EverybodysShelf /> : null}
    </div>
  )
}
