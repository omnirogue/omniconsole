import { describe, expect, it } from 'vitest'
import {
  buildCatalog,
  changedSources,
  checkUpstream,
  canonicalize,
  normalizeAutoOperationIds,
  normalizeBffText
} from './sync-console-api-source-catalog.mjs'

const hub = `export interface paths {
    "/api/example": {
        get: operations["get_example"];
    };
}
`
const bff = JSON.stringify({
  info: { title: 'omni-bff' },
  paths: { '/api/example': { get: { operationId: 'get_example' } } }
})

describe('source catalog drift', () => {
  it('ignores OpenAPI whitespace but identifies a changed source contract', () => {
    const baseline = buildCatalog(normalizeBffText(bff), hub)
    const formatted = JSON.stringify(JSON.parse(bff), null, 2)
    expect(changedSources(buildCatalog(normalizeBffText(formatted), hub), baseline)).toEqual([])
    const changed = bff.replace('get_example', 'get_example_v2')
    expect(changedSources(buildCatalog(normalizeBffText(changed), hub), baseline)).toEqual([
      'bff-openapi'
    ])
  })
})

const route = '/api/task-completion/{task_id}'
const prefix = 'controls_api_task_completion__task_id'
function multiMethodDoc(suffix = 'put') {
  const operation = () => ({
    operationId: `${prefix}__${suffix}`,
    summary: 'Complete task',
    parameters: [{ name: 'task_id', in: 'path', schema: { type: 'string' } }],
    responses: {
      200: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { done: { type: 'boolean', default: false } },
              required: ['done', 'id']
            }
          }
        }
      }
    }
  })
  return {
    info: { title: 'omni-bff' },
    paths: {
      [route]: { put: operation(), get: operation() }
    }
  }
}
function compareDocs(current, expected, currentHub = hub) {
  const currentText = normalizeBffText(JSON.stringify(current))
  const expectedText = normalizeBffText(JSON.stringify(expected))
  const notes = []
  checkUpstream(
    buildCatalog(currentText, currentHub),
    buildCatalog(expectedText, hub),
    currentText,
    expectedText,
    (note) => notes.push(note)
  )
  return notes
}

describe('upstream semantic decision', () => {
  it.each([
    [
      'method key order',
      (doc) => {
        const { put, get } = doc.paths[route]
        doc.paths[route] = { get, put }
      }
    ],
    [
      'nested parameter schema key order',
      (doc) => {
        doc.paths[route].get.parameters[0].schema = {
          properties: { value: { description: 'Value', type: 'string' } },
          type: 'object'
        }
      }
    ],
    [
      'top-level key order',
      (doc) => {
        const info = doc.info
        delete doc.info
        doc.info = info
      }
    ]
  ])('ignores %s while retaining raw hash differences', (name, change) => {
    const expected = multiMethodDoc()
    if (name === 'nested parameter schema key order') {
      expected.paths[route].get.parameters[0].schema = {
        type: 'object',
        properties: { value: { type: 'string', description: 'Value' } }
      }
    }
    const current = structuredClone(expected)
    change(current)
    const currentCatalog = buildCatalog(normalizeBffText(JSON.stringify(current)), hub)
    const expectedCatalog = buildCatalog(normalizeBffText(JSON.stringify(expected)), hub)
    expect(currentCatalog.sources['bff-openapi'].sha256).not.toBe(
      expectedCatalog.sources['bff-openapi'].sha256
    )
    expect(changedSources(currentCatalog, expectedCatalog)).toEqual(['bff-openapi'])
    expect(compareDocs(current, expected)).toEqual([
      'bff-openapi: raw hash differs but the contract is semantically identical.'
    ])
  })

  it('normalizes a shared method suffix on a deep copy', () => {
    const doc = multiMethodDoc()
    const before = JSON.stringify(doc)
    const normalized = normalizeAutoOperationIds(doc)
    expect(normalized.paths[route].get.operationId).toBe(`${prefix} __multi`)
    expect(normalized.paths[route].put.operationId).toBe(`${prefix} __multi`)
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('reports a rename to the literal former sentinel', () => {
    const expected = multiMethodDoc()
    const current = multiMethodDoc('multi')
    expect(normalizeAutoOperationIds(current)).toEqual(current)
    expect(() => compareDocs(current, expected)).toThrow(
      `$["paths"]["${route}"]["get"]["operationId"]`
    )
  })

  it('ignores shared single-underscore suffix flips on the GTD dispatch route', () => {
    const path = '/api/gtd/dispatch'
    const doc = (suffix) => ({
      info: { title: 'omni-bff' },
      paths: {
        [path]: {
          get: { operationId: `gtd_dispatch_store_api_gtd_dispatch_${suffix}` },
          post: { operationId: `gtd_dispatch_store_api_gtd_dispatch_${suffix}` }
        }
      }
    })
    expect(compareDocs(doc('get'), doc('post'))).toEqual([
      'bff-openapi: raw hash differs but the contract is semantically identical.'
    ])
  })

  it.each([
    ['/api/foo', ['get'], 'foo_api_foo_get', 'foo_api_fooz_get'],
    [
      '/api/gtd/memory',
      ['get', 'post'],
      'gtd_memory_api_gtd_memory_post',
      'gtd_memory_api_gtd_memoryz_post'
    ]
  ])('reports single-underscore operationId renames on %s', (path, methods, before, after) => {
    const doc = (operationId) => ({
      info: { title: 'omni-bff' },
      paths: {
        [path]: Object.fromEntries(methods.map((method) => [method, { operationId }]))
      }
    })
    if (methods.length === 1) {
      expect(normalizeAutoOperationIds(doc(before))).toEqual(doc(before))
    }
    expect(() => compareDocs(doc(after), doc(before))).toThrow(
      `$["paths"]["${path}"]["get"]["operationId"]`
    )
  })

  it.each([
    [
      'single-method operationId rename',
      (doc) => {
        doc.paths['/single'].get.operationId = 'renamed__get'
      },
      'operationId'
    ],
    [
      'consistent multi-method prefix rename',
      (doc) => {
        for (const method of ['get', 'put']) {
          doc.paths[route][method].operationId = `controlz_api_task_completion__task_id__get`
        }
      },
      'operationId'
    ],
    [
      'parameter added',
      (doc) => {
        doc.paths[route].get.parameters.push({ name: 'extra', in: 'query' })
      },
      'parameters'
    ],
    [
      'parameter removed',
      (doc) => {
        doc.paths[route].get.parameters.pop()
      },
      'parameters'
    ],
    [
      'response schema property changed',
      (doc) => {
        doc.paths[route].get.responses[200].content[
          'application/json'
        ].schema.properties.done.type = 'string'
      },
      'responses'
    ],
    [
      'component schema changed',
      (doc) => {
        doc.components.schemas.Task.type = 'string'
      },
      'components'
    ],
    [
      'security requirement added',
      (doc) => {
        doc.paths[route].get.security = [{ bearer: [] }]
      },
      'security'
    ],
    [
      'summary changed',
      (doc) => {
        doc.paths[route].get.summary = 'Different'
      },
      'summary'
    ],
    [
      'path added',
      (doc) => {
        doc.paths['/new'] = { get: { operationId: 'new' } }
      },
      '/new'
    ],
    [
      'path removed',
      (doc) => {
        delete doc.paths[route]
      },
      route
    ],
    [
      'method added',
      (doc) => {
        doc.paths[route].post = { operationId: 'new' }
      },
      'post'
    ],
    [
      'method removed',
      (doc) => {
        delete doc.paths[route].put
      },
      'put'
    ],
    [
      'required array reordered',
      (doc) => {
        doc.paths[route].get.responses[200].content['application/json'].schema.required.reverse()
      },
      'required'
    ],
    [
      'security array reordered',
      (doc) => {
        doc.security.reverse()
      },
      'security'
    ],
    [
      'differing per-operation suffixes',
      (doc) => {
        doc.paths[route].get.operationId = `${prefix}__put`
        doc.paths[route].put.operationId = `${prefix}__get`
      },
      'operationId'
    ]
  ])('reports %s', (_name, change, pointer) => {
    const expected = multiMethodDoc()
    expected.paths['/single'] = { get: { operationId: 'single__get' } }
    expected.components = { schemas: { Task: { type: 'object' } } }
    expected.security = [{ bearer: [] }, { apiKey: [] }]
    const current = structuredClone(expected)
    change(current)
    expect(() => compareDocs(current, expected)).toThrow('Upstream contracts changed: bff-openapi')
    expect(() => compareDocs(current, expected)).toThrow(pointer)
  })

  it.each([
    ['different prefix', 'other__put'],
    ['non-auto ID', 'custom'],
    ['missing ID', undefined],
    ['different method suffix', `${prefix}__get`]
  ])('leaves all IDs untouched for %s', (_name, id) => {
    const doc = multiMethodDoc()
    doc.paths[route].put.operationId = id
    expect(normalizeAutoOperationIds(doc)).toEqual(doc)
  })

  it('leaves single-method auto-pattern IDs untouched', () => {
    const doc = multiMethodDoc()
    delete doc.paths[route].put
    expect(normalizeAutoOperationIds(doc)).toEqual(doc)
  })

  it('ignores shared suffix flips from committed put to live get', () => {
    const expected = multiMethodDoc('put')
    const current = multiMethodDoc('get')
    expect(normalizeAutoOperationIds(current)).toEqual(normalizeAutoOperationIds(expected))
    expect(compareDocs(current, expected)).toEqual([
      'bff-openapi: raw hash differs but the contract is semantically identical.'
    ])
  })

  it.each(['get', 'put'])('preserves distinct hand-authored IDs when %s changes', (method) => {
    const expected = multiMethodDoc()
    expected.paths[route].get.operationId = `${prefix}__get`
    const current = structuredClone(expected)
    current.paths[route][method].operationId = `custom_${method}_task_completion`
    expect(normalizeAutoOperationIds(expected)).toEqual(expected)
    expect(normalizeAutoOperationIds(current)).toEqual(current)
    expect(() => compareDocs(current, expected)).toThrow('operationId')
  })

  it.each([`${prefix}__post`, `${prefix} __multi`, 'custom', undefined])(
    'preserves shared IDs outside the path method auto-pattern: %s',
    (id) => {
      const doc = multiMethodDoc()
      for (const method of ['get', 'put']) {
        doc.paths[route][method].operationId = id
      }
      expect(normalizeAutoOperationIds(doc)).toEqual(doc)
    }
  )

  it('canonicalizes objects recursively and preserves arrays and primitives', () => {
    expect(JSON.stringify(canonicalize({ z: null, a: [{ z: 1, a: false }, 'x'] }))).toBe(
      '{"a":[{"a":false,"z":1},"x"],"z":null}'
    )
  })

  it('retains raw-text hub drift detection', () => {
    expect(() => compareDocs(JSON.parse(bff), JSON.parse(bff), `${hub}\n`)).toThrow(
      'hub-types (raw text changed)'
    )
  })

  it('caps diagnostic differences at five paths', () => {
    const expected = JSON.parse(bff)
    const current = { ...expected, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }
    expect(() => compareDocs(current, expected)).toThrow('$["e"]')
    try {
      compareDocs(current, expected)
    } catch (error) {
      expect(error.message).not.toContain('$["f"]')
    }
  })
})
