import {
  WORKFLOW_CREDENTIAL_NAMES,
  WORKFLOW_PROVIDER_HOME_PREFIXES
} from '../local-workflow-read-scope'

// The one-segment credential names (Library/Keychains is refused as part of ~/Library).
const CREDENTIAL_NAMES = new Set(
  WORKFLOW_CREDENTIAL_NAMES.filter((name) => !/[\\/]/.test(name)).map((name) => name.toLowerCase())
)
// Copies agents never need: installed packages and Git's own data (remote URLs may hold tokens).
const SKIPPED_NAMES = new Set(['node_modules', '.git'])

/** A file or folder name where logins and keys are kept, at any depth. */
export function workflowContextCredentialName(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    CREDENTIAL_NAMES.has(lower) ||
    lower.startsWith('.env.') ||
    WORKFLOW_PROVIDER_HOME_PREFIXES.some((prefix) => lower.startsWith(prefix))
  )
}

/** A name the context copy leaves out: credentials, installed packages and Git's data. */
export function workflowContextSkippedName(name: string): boolean {
  return SKIPPED_NAMES.has(name.toLowerCase()) || workflowContextCredentialName(name)
}
