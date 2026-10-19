import { describe, expect, it } from 'vitest'
import {
  searchOmniRogueMcpCatalog,
  type OmniRogueMcpCatalogTool
} from './omnirogue-mcp-catalog-search'

const catalog: readonly OmniRogueMcpCatalogTool[] = [
  {
    name: 'media_generate_image',
    title: 'Create artwork',
    description: 'Generate an image from a prompt.',
    inputSchema: { type: 'object', properties: { prompt: {}, aspectRatio: {} } }
  },
  {
    name: 'media_generate_video',
    description: 'Generate a video from an image.',
    inputSchema: { type: 'object', properties: { imageUrl: {}, duration: {} } }
  },
  { name: 'credits_balance', description: 'Read the available wallet credits.' },
  { name: 'si_discover', description: 'Discover research candidates.' }
]

const names = (tools: readonly OmniRogueMcpCatalogTool[]): string[] =>
  tools.map((tool) => tool.name)

describe('searchOmniRogueMcpCatalog', () => {
  it('ranks an exact name ahead of prefixes, title, parameters and description matches', () => {
    const tools = [
      { name: 'a_description', description: 'image' },
      { name: 'b_parameter', inputSchema: { properties: { image: {} } } },
      { name: 'c_title', title: 'Image' },
      { name: 'image_variants' },
      { name: 'image' }
    ]
    expect(names(searchOmniRogueMcpCatalog(tools, 'image'))).toEqual([
      'image',
      'image_variants',
      'c_title',
      'b_parameter',
      'a_description'
    ])
  })

  it.each([
    '  MEDIA.Generate-Image  ',
    'mediaGenerateImage',
    'ＭＥＤＩＡ＿ＧＥＮＥＲＡＴＥ＿ＩＭＡＧＥ'
  ])('normalizes case, separators, camel case and Unicode: %s', (query) => {
    expect(searchOmniRogueMcpCatalog(catalog, query)[0]).toBe(catalog[0])
  })

  it('matches all terms across different metadata fields', () => {
    expect(names(searchOmniRogueMcpCatalog(catalog, 'media artwork aspect ratio'))).toEqual([
      'media_generate_image'
    ])
    expect(searchOmniRogueMcpCatalog(catalog, 'media wallet')).toEqual([])
  })

  it('matches partial names while preferring whole words over word prefixes and substrings', () => {
    const tools = [{ name: 'x_images' }, { name: 'x_reimage' }, { name: 'x_image' }]
    expect(names(searchOmniRogueMcpCatalog(tools, 'image'))).toEqual([
      'x_image',
      'x_images',
      'x_reimage'
    ])
  })

  it('uses only schema property names, not defaults or other schema contents', () => {
    const tools = [
      {
        name: 'generate',
        inputSchema: {
          properties: { aspectRatio: { default: 'private-value' } },
          description: 'hidden-schema-text'
        }
      }
    ]
    expect(searchOmniRogueMcpCatalog(tools, 'aspect ratio')).toEqual(tools)
    expect(searchOmniRogueMcpCatalog(tools, 'private')).toEqual([])
    expect(searchOmniRogueMcpCatalog(tools, 'hidden')).toEqual([])
  })

  it.each([undefined, null, [], 'invalid', 42])(
    'ignores non-object schema properties: %j',
    (properties) => {
      const tools = [{ name: 'image', inputSchema: { properties } }]
      expect(searchOmniRogueMcpCatalog(tools, 'image')).toEqual(tools)
      expect(searchOmniRogueMcpCatalog(tools, 'unknown')).toEqual([])
    }
  )

  it('breaks score ties by name regardless of input order', () => {
    const tied = [
      { name: 'z_tool', description: 'match' },
      { name: 'a_tool', description: 'match' }
    ]
    expect(names(searchOmniRogueMcpCatalog(tied, 'match'))).toEqual(['a_tool', 'z_tool'])
    expect(searchOmniRogueMcpCatalog(tied.toReversed(), 'match')).toEqual(
      searchOmniRogueMcpCatalog(tied, 'match')
    )
  })

  it.each(['', '   \n\t'])('lists the catalog alphabetically for a blank query: %j', (query) => {
    expect(names(searchOmniRogueMcpCatalog(catalog, query))).toEqual([
      'credits_balance',
      'media_generate_image',
      'media_generate_video',
      'si_discover'
    ])
  })

  it.each(['.*', '---', '[]', 'missing-tool'])('returns no matches for %j', (query) => {
    expect(searchOmniRogueMcpCatalog(catalog, query)).toEqual([])
  })

  it('handles empty catalogs and omits blank tool names', () => {
    expect(searchOmniRogueMcpCatalog([], '')).toEqual([])
    expect(searchOmniRogueMcpCatalog([{ name: '  ' }, { name: '---' }], '')).toEqual([])
  })

  it('supports non-Latin metadata', () => {
    const tools = [{ name: 'create', title: '画像を生成' }]
    expect(searchOmniRogueMcpCatalog(tools, '画像')).toEqual(tools)
  })

  it('applies limits after ranking, rounds down fractions and caps result counts', () => {
    const tools = Array.from({ length: 120 }, (_, index) => ({ name: `tool_${index}` }))
    expect(searchOmniRogueMcpCatalog(tools, '')).toHaveLength(20)
    expect(searchOmniRogueMcpCatalog(tools, '', 500)).toHaveLength(100)
    expect(searchOmniRogueMcpCatalog(catalog, 'image', 1.9)).toEqual([catalog[0]])
    expect(searchOmniRogueMcpCatalog(catalog, '', 0)).toEqual([])
    expect(searchOmniRogueMcpCatalog(catalog, '', -1)).toEqual([])
  })

  it.each([Number.NaN, Infinity, -Infinity])('uses the default limit for %s', (limit) => {
    const tools = Array.from({ length: 30 }, (_, index) => ({ name: `tool_${index}` }))
    expect(searchOmniRogueMcpCatalog(tools, '', limit)).toHaveLength(20)
  })

  it('preserves complete tool definitions and does not mutate the caller catalog', () => {
    const schema = Object.freeze({ type: 'object', properties: Object.freeze({ prompt: {} }) })
    const tool = Object.freeze({
      name: 'z_image',
      inputSchema: schema,
      annotations: { readOnlyHint: true }
    })
    const other = Object.freeze({
      name: 'a_image',
      inputSchema: schema,
      annotations: { readOnlyHint: false }
    })
    const tools = Object.freeze([tool, other])
    const result = searchOmniRogueMcpCatalog(tools, 'image')
    expect(result).toEqual([other, tool])
    expect(result[1]).toBe(tool)
    expect(result[1].inputSchema).toBe(schema)
    expect(result[1].annotations.readOnlyHint).toBe(true)
    expect(tools).toEqual([tool, other])
  })
})
