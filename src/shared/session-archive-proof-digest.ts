/**
 * A short digest for the archive proof tokens main writes into a change's free-text evidence and
 * the window compares synchronously before filing. The evidence is capped at 1000 characters,
 * and a raw owner revision (it repeats the workspace path) can pass that alone, so the tokens
 * carry 16 hex characters instead. Pure JavaScript on both sides: no crypto, no await.
 */
export function archiveProofDigest(text: string): string {
  // Why FNV-1a twice: two seeds give 64 bits, plenty to tell one revision from the next.
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x7f4a7c15
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x01000193) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}
