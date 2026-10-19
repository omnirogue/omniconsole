// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OmniRogueMcpApi } from '../../../../preload/api/omnirogue-api'
import { OmniSiMcpExplorerEntry } from './OmniSiMcpExplorerEntry'

const catalog = [
  { name: 'media_generate', description: 'Generate an image' },
  { name: 'credits_balance', description: 'Read the wallet' }
]

function api(): OmniRogueMcpApi & { searchOmniSiTools: ReturnType<typeof vi.fn> } {
  return {
    searchOmniSiTools: vi.fn(async ({ query }: { query: string }) => ({
      tools: query ? catalog.filter((tool) => tool.name.includes(query)) : catalog,
      total: catalog.length
    }))
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('OmniSiMcpExplorerEntry', () => {
  it('loads the catalog when opened', async () => {
    const mcpApi = api()
    render(<OmniSiMcpExplorerEntry mcpApi={mcpApi} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse tools' }))
    expect(await screen.findByText('2 of 2 tools')).toBeTruthy()
    expect(mcpApi.searchOmniSiTools).toHaveBeenCalledWith({ query: '', refresh: false })
  })

  it('ranks typed queries in main after a short pause', async () => {
    const mcpApi = api()
    render(<OmniSiMcpExplorerEntry mcpApi={mcpApi} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse tools' }))
    await screen.findByText('2 of 2 tools')
    vi.useFakeTimers()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tools' }), {
      target: { value: 'media' }
    })
    expect(mcpApi.searchOmniSiTools).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(mcpApi.searchOmniSiTools).toHaveBeenLastCalledWith({ query: 'media', refresh: false })
    expect(screen.getByText('1 of 2 tools')).toBeTruthy()
  })

  it('refreshes past the cache and reports failures', async () => {
    const mcpApi = api()
    render(<OmniSiMcpExplorerEntry mcpApi={mcpApi} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse tools' }))
    await screen.findByText('2 of 2 tools')
    mcpApi.searchOmniSiTools.mockRejectedValueOnce(new Error('HTTP 503'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('HTTP 503')).toBeTruthy()
    expect(mcpApi.searchOmniSiTools).toHaveBeenLastCalledWith({ query: '', refresh: true })
  })
})
