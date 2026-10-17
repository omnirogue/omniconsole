import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Static (Model2Vec) sentence embeddings: a WordPiece lookup table averaged per text. No
// network, no native code, ~2 MB, microseconds per summary — enough to relate "omnirogue
// production" to a summary about `prod-omnirogue` deploys without sending text anywhere.

export type StaticEmbeddingModel = {
  dimensions: number
  embed(text: string): Float32Array
}

// Layout: 'SSE2', u32 vocab size, u32 dimensions, u32 vocab bytes, newline-separated
// WordPiece vocab (UTF-8, id order), float32 row scales, int8 rows.
const MAGIC = 'SSE2'
const HEADER_BYTES = 16
const MAX_WORD_CHARS = 100
/** Long inputs add little meaning past this and cost linear time. */
const MAX_EMBED_CHARS = 8_000

type LoadedTable = {
  vocab: Map<string, number>
  unknownId: number
  scales: Float32Array
  rows: Int8Array
  dimensions: number
}

function parseTable(bin: Buffer): LoadedTable {
  if (bin.length < HEADER_BYTES || bin.subarray(0, 4).toString('latin1') !== MAGIC) {
    throw new Error('session search embedding table has an unknown format')
  }
  const size = bin.readUInt32LE(4)
  const dimensions = bin.readUInt32LE(8)
  const vocabBytes = bin.readUInt32LE(12)
  const scalesBytes = size * 4
  if (bin.length !== HEADER_BYTES + vocabBytes + scalesBytes + size * dimensions) {
    throw new Error('session search embedding table is truncated')
  }
  const tokens = bin
    .subarray(HEADER_BYTES, HEADER_BYTES + vocabBytes)
    .toString('utf8')
    .split('\n')
    .slice(0, size)
  const vocab = new Map<string, number>()
  tokens.forEach((token, id) => vocab.set(token, id))
  const copy = Uint8Array.prototype.slice.call(bin, HEADER_BYTES + vocabBytes)
  return {
    vocab,
    unknownId: vocab.get('[UNK]') ?? -1,
    scales: new Float32Array(copy.buffer, 0, size),
    rows: new Int8Array(copy.buffer, scalesBytes, size * dimensions),
    dimensions
  }
}

/** BERT pre-tokenization: lowercase, strip accents, split on whitespace and punctuation. */
function preTokenize(text: string): string[] {
  return (
    text
      .slice(0, MAX_EMBED_CHARS)
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Mn}/gu, '')
      .match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? []
  )
}

/** Greedy longest-match WordPiece; a word that cannot be covered is unknown. */
function wordPiece(word: string, table: LoadedTable): number[] {
  if (word.length > MAX_WORD_CHARS) {
    return []
  }
  const ids: number[] = []
  let start = 0
  while (start < word.length) {
    let end = word.length
    let found = -1
    while (start < end) {
      const piece = (start > 0 ? '##' : '') + word.slice(start, end)
      const id = table.vocab.get(piece)
      if (id !== undefined) {
        found = id
        break
      }
      end -= 1
    }
    if (found < 0) {
      return []
    }
    ids.push(found)
    start = end
  }
  return ids
}

export function createStaticEmbeddingModel(bin: Buffer): StaticEmbeddingModel {
  const table = parseTable(bin)
  const { dimensions, rows, scales } = table
  return {
    dimensions,
    embed(text: string): Float32Array {
      const vector = new Float32Array(dimensions)
      for (const word of preTokenize(text)) {
        for (const id of wordPiece(word, table)) {
          if (id === table.unknownId) {
            continue
          }
          const scale = scales[id]!
          const base = id * dimensions
          for (let d = 0; d < dimensions; d++) {
            vector[d] += rows[base + d]! * scale
          }
        }
      }
      return normalize(vector)
    }
  }
}

function normalize(vector: Float32Array): Float32Array {
  let norm = 0
  for (const value of vector) {
    norm += value * value
  }
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let d = 0; d < vector.length; d++) {
      vector[d] /= norm
    }
  }
  return vector
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length)
  let sum = 0
  for (let d = 0; d < length; d++) {
    sum += left[d]! * right[d]!
  }
  return sum
}

export function embeddingToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength)
  )
}

export function embeddingFromBlob(blob: Uint8Array | null | undefined): Float32Array | null {
  if (!blob || blob.byteLength % 4 !== 0 || blob.byteLength === 0) {
    return null
  }
  return new Float32Array(Uint8Array.prototype.slice.call(blob).buffer)
}

/** Load the bundled model from `dir`; null (keyword search only) when it is missing. */
export function loadStaticEmbeddingModel(dir: string): StaticEmbeddingModel | null {
  try {
    return createStaticEmbeddingModel(readFileSync(join(dir, 'static-embedding.bin')))
  } catch {
    return null
  }
}
