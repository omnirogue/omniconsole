/** Tool names, across providers, whose call writes the file named in its input. */
const AGENT_WRITE_TOOL_OPS: Readonly<Record<string, 'edit' | 'create'>> = {
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'create',
  Create: 'create',
  write_file: 'create',
  edit_file: 'edit',
  replace: 'edit',
  search_replace: 'edit',
  write_to_file: 'create',
  apply_patch: 'edit',
  patch: 'edit',
  create: 'create',
  write: 'create',
  edit: 'edit',
  replace_file_content: 'edit',
  multi_replace_file_content: 'edit',
  str_replace_editor: 'edit',
  str_replace_based_edit_tool: 'edit'
}

export function agentWriteToolOp(toolName: string | undefined): 'edit' | 'create' | undefined {
  return toolName && Object.hasOwn(AGENT_WRITE_TOOL_OPS, toolName)
    ? AGENT_WRITE_TOOL_OPS[toolName]
    : undefined
}

/** The keys a write-class tool names its file under, across every provider the listener knows. */
const PATH_KEYS = [
  'file_path',
  'path',
  'filePath',
  'filepath',
  'target_file',
  'notebook_path',
  'TargetFile',
  'AbsolutePath'
] as const
const PATH_MAX_RAW_LENGTH = 1024
// Why: real paths carry spaces (`My Project/a.ts`); they never carry a newline or NUL.
const NOT_A_PATH = /[\n\r\0]/
// Why: a serialized payload in the path position — `{…}`, `[…]` or a `"key":` shape — is content.
const OBJECT_LIKE = /^[[{]|"[^"\n]*"\s*:/

function pathString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > PATH_MAX_RAW_LENGTH || NOT_A_PATH.test(trimmed)) {
    return null
  }
  return trimmed
}

/**
 * The file a write-class tool targets, or null when the observation does not carry a clean
 * path. A JSON payload is read at its path keys only; a plain string counts only when it is
 * not object-like — file contents, patches and whole payloads never become a published path.
 */
export function writeTargetPath(toolInput: string | undefined): string | null {
  const raw = toolInput?.trim()
  if (!raw) {
    return null
  }
  if (raw.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const record = parsed as Record<string, unknown>
    for (const key of PATH_KEYS) {
      const candidate = pathString(record[key])
      if (candidate) {
        return candidate
      }
    }
    return null
  }
  return OBJECT_LIKE.test(raw) ? null : pathString(raw)
}
