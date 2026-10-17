/** Coerces untrusted spec values (drafts, saved presets, model-written plans) into bounds. */
export const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, number))
}

export const cleanText = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''

export const cleanBlock = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''
