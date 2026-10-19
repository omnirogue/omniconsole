import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type * as I18nModule from '@/i18n/i18n'
import type { SettingsRenderContext } from './settings-render-context'

// Why partial: panels in this section's import graph also read the `i18n` instance (main-next since #1216).
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18nModule>()),
  translate: (_key: string, english: string) => english
}))
vi.mock('./SettingsSection', () => ({
  SettingsSection: ({ id, children }: { id: string; children: React.ReactNode }) => (
    <section data-section={id}>{children}</section>
  )
}))
vi.mock('./OrcaAccountSettingsPane', () => ({
  OrcaAccountSettingsPane: () => <div data-pane="account" />
}))
vi.mock('./OmniRogueDiagnosticsCard', () => ({
  OmniRogueDiagnosticsCard: () => <div data-pane="doctor" />
}))
vi.mock('./OmniRogueGatewayHealthCard', () => ({
  OmniRogueGatewayHealthCard: () => <div data-pane="gateway-health" />
}))
vi.mock('./OmniSiMcpExplorerEntry', () => ({
  OmniSiMcpExplorerEntry: () => <div data-pane="mcp-explorer" />
}))

const { renderOrcaAccountSettingsSection } =
  await import('./settings-setup-workflow-section-renderers')

function context(showDesktopOnlySettings: boolean): SettingsRenderContext {
  return {
    model: { showDesktopOnlySettings },
    navigation: { getSectionSearchEntries: () => [] },
    view: { isSectionMounted: () => true }
  } as unknown as SettingsRenderContext
}

describe('renderOrcaAccountSettingsSection', () => {
  it('mounts the gateway health card and the OmniSI tool explorer beside the doctor', () => {
    const markup = renderToStaticMarkup(<>{renderOrcaAccountSettingsSection(context(true))}</>)
    const order = ['account', 'doctor', 'gateway-health', 'mcp-explorer'].map((pane) =>
      markup.indexOf(`data-pane="${pane}"`)
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('renders nothing outside the desktop app', () => {
    expect(renderOrcaAccountSettingsSection(context(false))).toBeNull()
  })
})
