// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OmniSiMcpExplorerDrawer,
  type OmniSiMcpExplorerDrawerProps
} from './OmniSiMcpExplorerDrawer'
import {
  filterOmniSiMcpTools,
  formatOmniSiMcpSchema,
  getOmniSiMcpParameters,
  omniSiMcpExplorerLabels as labels,
  type OmniSiMcpTool
} from './omnisi-mcp-explorer-helpers'

const tools: OmniSiMcpTool[] = [
  {
    name: 'pages_search',
    title: 'Find pages',
    description: 'Search shared documents',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Words to find' },
        limit: { type: ['integer', 'null'] }
      }
    }
  },
  { name: 'decisions_list', description: 'List open decisions', inputSchema: { type: 'object' } }
]

function drawerProps(
  overrides: Partial<OmniSiMcpExplorerDrawerProps> = {}
): OmniSiMcpExplorerDrawerProps {
  return { open: true, onOpenChange: vi.fn(), tools, ...overrides }
}

afterEach(cleanup)

describe('OmniSiMcpExplorerDrawer', () => {
  it('shows tool details, required inputs, and the original schema', () => {
    render(<OmniSiMcpExplorerDrawer {...drawerProps()} />)
    const details = within(screen.getByRole('region', { name: labels.details }))
    expect(screen.getByRole('dialog', { name: labels.title })).toBeTruthy()
    expect(details.getByText(tools[0].title!)).toBeTruthy()
    expect(details.getByText('query')).toBeTruthy()
    expect(details.getByText(labels.required)).toBeTruthy()
    expect(details.getByText(labels.optional)).toBeTruthy()
    expect(details.getByText('integer | null')).toBeTruthy()
    fireEvent.click(details.getByText(labels.inputSchema))
    expect(
      screen.getByRole('region', { name: labels.details }).querySelector('pre')?.textContent
    ).toBe(JSON.stringify(tools[0].inputSchema, null, 2))
  })

  it('filters by name, title and description, ignoring case and surrounding whitespace', () => {
    render(<OmniSiMcpExplorerDrawer {...drawerProps()} />)
    fireEvent.change(screen.getByRole('searchbox', { name: labels.search }), {
      target: { value: ' FIND  shared ' }
    })
    expect(screen.getByRole('button', { name: tools[0].name })).toBeTruthy()
    expect(screen.queryByRole('button', { name: tools[1].name })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(labels.toolCount(1, 2))
  })

  it('selects a tool and falls back when it is filtered out or removed', () => {
    const props = drawerProps()
    const view = render(<OmniSiMcpExplorerDrawer {...props} />)
    fireEvent.click(screen.getByRole('button', { name: tools[1].name }))
    expect(screen.getByRole('button', { name: tools[1].name }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(
      within(screen.getByRole('region', { name: labels.details })).getByText(labels.noParameters)
    ).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'pages' } })
    expect(screen.getByRole('button', { name: tools[0].name }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    view.rerender(<OmniSiMcpExplorerDrawer {...props} tools={[tools[0]]} />)
    expect(screen.getByRole('button', { name: tools[0].name }).getAttribute('aria-pressed')).toBe(
      'true'
    )
  })

  it('distinguishes an empty catalog from a search with no matches and clears the search', () => {
    const props = drawerProps()
    const view = render(<OmniSiMcpExplorerDrawer {...props} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'unmatched' } })
    expect(screen.getByText(labels.noMatches)).toBeTruthy()
    expect(screen.queryByRole('region', { name: labels.details })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: labels.clearSearch }))
    expect(screen.getByRole('button', { name: tools[0].name })).toBeTruthy()
    view.rerender(<OmniSiMcpExplorerDrawer {...props} tools={[]} />)
    expect(screen.getByText(labels.empty)).toBeTruthy()
    expect(screen.queryByText(labels.noMatches)).toBeNull()
  })

  it('reports loading and errors without presenting stale tools as current results', () => {
    const onRefresh = vi.fn()
    const props = drawerProps({ loading: true, onRefresh })
    const view = render(<OmniSiMcpExplorerDrawer {...props} />)
    expect(screen.getByRole('status').textContent).toBe(labels.loading)
    expect(screen.queryByRole('button', { name: tools[0].name })).toBeNull()
    const refresh = screen.getByRole<HTMLButtonElement>('button', { name: labels.refresh })
    expect(refresh.disabled).toBe(true)
    fireEvent.click(refresh)
    expect(onRefresh).not.toHaveBeenCalled()
    const error = 'Connection unavailable'
    view.rerender(<OmniSiMcpExplorerDrawer {...props} loading={false} error={error} />)
    expect(screen.getByRole('alert').textContent).toContain(error)
    expect(screen.queryByRole('button', { name: tools[0].name })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: labels.refresh }))
    expect(onRefresh).toHaveBeenCalledOnce()
    view.rerender(<OmniSiMcpExplorerDrawer {...props} loading={false} error={null} />)
    expect(screen.getByRole('button', { name: tools[0].name })).toBeTruthy()
  })

  it('uses supplied labels for its chrome and accessible names', () => {
    const overrides = {
      title: 'Explorador',
      description: 'Herramientas disponibles',
      close: 'Cerrar',
      search: 'Buscar',
      searchPlaceholder: 'Buscar herramientas',
      tools: 'Herramientas',
      details: 'Detalles',
      parameters: 'Parámetros',
      inputSchema: 'Esquema',
      required: 'Obligatorio',
      optional: 'Opcional',
      refresh: 'Actualizar',
      toolCount: (visible: number, total: number) => `${visible}/${total}`
    }
    render(<OmniSiMcpExplorerDrawer {...drawerProps({ labels: overrides, onRefresh: vi.fn() })} />)
    expect(screen.getByRole('dialog', { name: overrides.title })).toBeTruthy()
    expect(
      screen.getByRole('searchbox', { name: overrides.search }).getAttribute('placeholder')
    ).toBe(overrides.searchPlaceholder)
    expect(screen.getByRole('group', { name: overrides.tools })).toBeTruthy()
    expect(screen.getByRole('region', { name: overrides.details })).toBeTruthy()
    expect(screen.getByRole('button', { name: overrides.close })).toBeTruthy()
    expect(screen.getByRole('button', { name: overrides.refresh })).toBeTruthy()
    expect(screen.getByText(overrides.required)).toBeTruthy()
    expect(screen.getByText(overrides.optional)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('2/2')
    expect(screen.queryByText(labels.title)).toBeNull()
  })

  it('closes through the controlled callback and resets search when reopened', () => {
    const props = drawerProps()
    const view = render(<OmniSiMcpExplorerDrawer {...props} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'decisions' } })
    fireEvent.click(screen.getByRole('button', { name: labels.close }))
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
    view.rerender(<OmniSiMcpExplorerDrawer {...props} open={false} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<OmniSiMcpExplorerDrawer {...props} />)
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
    expect(screen.getByRole('button', { name: tools[0].name })).toBeTruthy()
  })

  it('shows fallbacks for missing metadata and renders tool descriptions as text', () => {
    const unsafeDescription = '<img src=x onerror=alert(1)>'
    const props = drawerProps({ tools: [{ name: 'tool', description: unsafeDescription }] })
    const view = render(<OmniSiMcpExplorerDrawer {...props} />)
    expect(screen.getByText(unsafeDescription)).toBeTruthy()
    expect(screen.getByText(labels.schemaUnavailable)).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
    view.rerender(<OmniSiMcpExplorerDrawer {...props} tools={[{ name: 'tool' }]} />)
    expect(screen.getByText(labels.noDescription)).toBeTruthy()
    expect(screen.queryByRole('button', { name: labels.refresh })).toBeNull()
  })
})

describe('MCP explorer metadata', () => {
  it('preserves catalog order and does not mutate the input', () => {
    const frozen = Object.freeze([...tools])
    expect(filterOmniSiMcpTools(frozen, '  ')).toEqual(tools)
    expect(filterOmniSiMcpTools(frozen, 'DECISIONS list')).toEqual([tools[1]])
    expect(filterOmniSiMcpTools(frozen, 'pages decisions')).toEqual([])
  })

  it('handles missing or non-object property definitions without throwing', () => {
    expect(getOmniSiMcpParameters(undefined)).toEqual([])
    expect(getOmniSiMcpParameters({ properties: [] })).toEqual([])
    expect(
      getOmniSiMcpParameters({ properties: { value: true, other: null }, required: 'value' })
    ).toEqual([
      { name: 'value', type: undefined, description: undefined, required: false },
      { name: 'other', type: undefined, description: undefined, required: false }
    ])
  })

  it('preserves complex schemas and handles unserializable metadata', () => {
    const schema = { allOf: [{ $ref: '#/$defs/input' }], $defs: { input: { type: 'object' } } }
    expect(formatOmniSiMcpSchema(schema)).toBe(JSON.stringify(schema, null, 2))
    expect(formatOmniSiMcpSchema(undefined)).toBeUndefined()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(formatOmniSiMcpSchema(cyclic)).toBeUndefined()
  })
})
