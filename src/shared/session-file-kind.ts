/** How the Files & links panel previews and opens a file the session wrote. */
export type SessionFileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'html'
  | 'pdf'
  | 'markdown'
  | 'csv'
  | 'document'
  | 'other'

const KIND_BY_EXTENSION: Record<string, SessionFileKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  avif: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  m4v: 'video',
  html: 'html',
  htm: 'html',
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  csv: 'csv',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  flac: 'audio',
  aiff: 'audio',
  docx: 'document',
  doc: 'document',
  pptx: 'document',
  ppt: 'document',
  key: 'document',
  xlsx: 'document',
  xls: 'document',
  numbers: 'document',
  pages: 'document',
  rtf: 'document',
  odt: 'document'
}

export function sessionFileExtension(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function classifySessionFile(path: string): SessionFileKind {
  return KIND_BY_EXTENSION[sessionFileExtension(path)] ?? 'other'
}

/** Video extensions the main process will make a first-frame thumbnail for. */
export const SESSION_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.entries(KIND_BY_EXTENSION)
    .filter(([, kind]) => kind === 'video')
    .map(([extension]) => extension)
)
