import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  cosineSimilarity,
  createStaticEmbeddingModel,
  embeddingFromBlob,
  embeddingToBlob,
  loadStaticEmbeddingModel
} from './session-search-embedding'

function table(vocab: string[], rows: number[][]): Buffer {
  const dimensions = rows[0]!.length
  const words = Buffer.from(vocab.join('\n'), 'utf8')
  const head = Buffer.alloc(16)
  head.write('SSE2', 0, 'latin1')
  head.writeUInt32LE(vocab.length, 4)
  head.writeUInt32LE(dimensions, 8)
  head.writeUInt32LE(words.length, 12)
  const scales = new Float32Array(vocab.length).fill(1 / 127)
  const data = Int8Array.from(rows.flat().map((value) => Math.round(value * 127)))
  return Buffer.concat([head, words, Buffer.from(scales.buffer), Buffer.from(data.buffer)])
}

describe('static embeddings', () => {
  const vocab = ['[PAD]', '[UNK]', 'prod', 'production', 'menu', '##s']
  const model = createStaticEmbeddingModel(
    table(vocab, [
      [0, 0],
      [0, 0],
      [1, 0.1],
      [0.9, 0.2],
      [0, 1],
      [0.1, 0.1]
    ])
  )

  it('embeds by averaging word pieces and normalizes', () => {
    const vector = model.embed('Production')
    expect(Math.hypot(...vector)).toBeCloseTo(1, 5)
    expect(cosineSimilarity(model.embed('prod'), model.embed('production'))).toBeGreaterThan(0.95)
    expect(cosineSimilarity(model.embed('prod'), model.embed('menus'))).toBeLessThan(0.3)
  })

  it('round-trips vectors through blobs', () => {
    const vector = model.embed('prod menu')
    expect(Array.from(embeddingFromBlob(embeddingToBlob(vector))!)).toEqual(Array.from(vector))
    expect(embeddingFromBlob(new Uint8Array(3))).toBeNull()
  })

  it('rejects a truncated table and falls back to keyword search when the model is missing', () => {
    expect(() => createStaticEmbeddingModel(Buffer.from('SSE2'))).toThrow()
    expect(loadStaticEmbeddingModel(join(__dirname, 'no-such-dir'))).toBeNull()
  })

  it('loads the bundled model', () => {
    const bundled = loadStaticEmbeddingModel(join(__dirname, '../../../resources/session-search'))
    expect(bundled?.dimensions).toBe(64)
    const deploy = bundled!.embed('production deploy failed on the release branch')
    expect(cosineSimilarity(bundled!.embed('prod deployment'), deploy)).toBeGreaterThan(
      cosineSimilarity(bundled!.embed('refund a customer'), deploy)
    )
  })
})
