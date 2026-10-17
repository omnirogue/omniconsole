import type React from 'react'
import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import {
  CompaniesRequestError,
  companiesErrorMessage,
  needsOmniosSignIn
} from '@/components/companies/companies-client'
import type { AccessCapability, ConsoleAccessApi } from '../../../../shared/console-access-contract'

/**
 * The vocabulary both halves of the Tool Shelf share: how to reach the signed
 * transport, how to say what a capability is, and how to render a list of them.
 *
 * Its own module so the member pane and the super-admin pane can each import it
 * without importing each other.
 */

export function accessApi(): ConsoleAccessApi {
  const api = window.api?.consoleAccess
  if (!api) {
    throw new CompaniesRequestError({
      code: 'capability_unavailable',
      message: translate(
        'toolShelf.apiUnavailable',
        'The Tool Shelf needs an updated OmniConsole desktop app.'
      )
    })
  }
  return api
}

function connectorOf(capability: AccessCapability): string {
  return capability.connector ?? capability.id.split('.')[0] ?? capability.id
}

function classLabel(capability: AccessCapability): string {
  if (capability.read_only || capability.action_class === 'read_only') {
    return translate('toolShelf.read', 'read')
  }
  if (capability.requires_approval) {
    return translate('toolShelf.needsApproval', 'needs approval')
  }
  return translate('toolShelf.write', 'write')
}

export function errorLine(error: unknown): string {
  if (needsOmniosSignIn(error)) {
    return translate(
      'toolShelf.signIn',
      'Sign in to OmniConsole (Backoffice above) to see your tools.'
    )
  }
  return companiesErrorMessage(error)
}

export function CapabilityRows({
  capabilities,
  sources
}: {
  capabilities: AccessCapability[]
  sources?: Record<string, { layer: string; name: string; effect: string }[]>
}): React.JSX.Element {
  const groups = useMemo(() => {
    const byConnector = new Map<string, AccessCapability[]>()
    for (const capability of capabilities) {
      const key = connectorOf(capability)
      byConnector.set(key, [...(byConnector.get(key) ?? []), capability])
    }
    return [...byConnector.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [capabilities])
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {translate('toolShelf.none', 'No tools are granted yet.')}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-3" data-testid="tool-shelf-capabilities">
      {groups.map(([connector, rows]) => (
        <li key={connector}>
          <div className="text-sm font-medium">{connector}</div>
          <ul className="mt-1 flex flex-col gap-1">
            {rows.map((capability) => {
              const granted =
                sources?.[capability.id]?.filter((step) => step.effect === 'granted') ?? []
              const from = granted.at(-1) ?? null
              return (
                <li key={capability.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span>{capability.label ?? capability.id}</span>
                  <span className="rounded border px-1 text-xs text-muted-foreground">
                    {classLabel(capability)}
                  </span>
                  {capability.company ? (
                    <span className="text-xs text-muted-foreground">{capability.company}</span>
                  ) : null}
                  {from ? (
                    <span className="text-xs text-muted-foreground">
                      {translate('toolShelf.from', 'from {{layer}} {{name}}', {
                        layer: from.layer,
                        name: from.name
                      })}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </li>
      ))}
    </ul>
  )
}
