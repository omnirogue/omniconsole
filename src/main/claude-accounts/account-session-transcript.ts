import { cpSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/** Copy only transcript artifacts; the seat remains the sole credential owner. */
export function copyClaudeResumeTranscript(
  sessionDir: string,
  seatDir: string,
  transcript: string
): void {
  const inside = relative(join(sessionDir, 'projects'), transcript)
  if (
    !inside ||
    isAbsolute(inside) ||
    inside === '..' ||
    inside.startsWith(`..${sep}`) ||
    !inside.endsWith('.jsonl')
  ) {
    return
  }
  const destination = join(seatDir, 'projects', inside)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(transcript, destination, { force: false, errorOnExist: false })
  const artifacts = transcript.slice(0, -'.jsonl'.length)
  try {
    cpSync(artifacts, destination.slice(0, -'.jsonl'.length), {
      recursive: true,
      force: false,
      errorOnExist: false
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}
