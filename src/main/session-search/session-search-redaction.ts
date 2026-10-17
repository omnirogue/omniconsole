import { redactString } from '../observability/redactor'

// Provider shapes the observability redactor does not know; transcripts paste these into
// shells and .env edits, and nothing secret may reach the index, a summary or a model.
const EXTRA_SECRET_SHAPES: RegExp[] = [
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bEAA[A-Za-z0-9]{60,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxapp-[A-Za-z0-9-]{20,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\bsk-or-v1-[A-Za-z0-9]{32,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g
]

/** Scrub secrets from transcript text before it is indexed, summarized or embedded. */
export function redactTranscriptText(text: string): string {
  let out = redactString(text)
  for (const shape of EXTRA_SECRET_SHAPES) {
    out = out.replace(shape, '[redacted:secret]')
  }
  return out
}
