// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpConnectorsApi } from '../../../../shared/mcp-connectors'
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
import { ConnectorsPane } from './ConnectorsPane'

describe('connector account settings', () => {
  let api: McpConnectorsApi
  beforeEach(() => {
    api = {
      accounts: vi.fn().mockResolvedValue([
        {
          id: 'codex:default',
          provider: 'codex',
          label: 'Codex · system default',
          available: true
        }
      ]),
      list: vi.fn().mockResolvedValue([{ name: 'docs', transport: 'http', enabled: true }]),
      add: vi.fn().mockResolvedValue(undefined),
      action: vi.fn().mockResolvedValue('signed-in')
    }
    Object.defineProperty(window, 'api', { configurable: true, value: { mcpConnectors: api } })
  })
  afterEach(cleanup)

  it('labels configured and authenticated servers without falsely claiming a connection', async () => {
    render(<ConnectorsPane />)
    expect(await screen.findByText('Configured · connection not verified')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    expect(await screen.findByText('Signed in · connection not verified')).toBeVisible()
    expect(api.action).toHaveBeenCalledWith('codex:default', 'docs', 'check')
  })
  it('adds to the chosen account and exposes partial failures without a success message', async () => {
    vi.mocked(api.add).mockRejectedValueOnce(new Error('provider failed'))
    render(<ConnectorsPane />)
    await screen.findByText('docs')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new-docs' } })
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://example.com/mcp' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not add to these accounts: Codex · system default'
      )
    )
    expect(api.add).toHaveBeenCalledWith('codex:default', {
      name: 'new-docs',
      transport: 'http',
      url: 'https://example.com/mcp'
    })
    expect(
      screen.queryByText('Connector added. Use Sign in for servers that require OAuth.')
    ).toBeNull()
  })
  it('requires removal confirmation and permits backing out without changing config', async () => {
    render(<ConnectorsPane />)
    await screen.findByText('docs')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByText('Remove from this account?')).toBeVisible()
    expect(api.action).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Remove from this account?')).toBeNull()
  })
})
