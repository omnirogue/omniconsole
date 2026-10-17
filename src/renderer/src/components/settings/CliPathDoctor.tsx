import { useEffect, useState } from 'react'
import type { CliPathFinding } from '../../../../shared/cli-install-types'
import { translate } from '@/i18n/i18n'

export function CliPathDoctor({ refreshKey }: { refreshKey: boolean }): React.JSX.Element | null {
  const [findings, setFindings] = useState<CliPathFinding[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    // Why: browser and older preloads cannot inspect the desktop user's PATH.
    if (typeof window.api.cli.getPathFindings !== 'function') {
      return
    }
    let active = true
    void window.api.cli
      .getPathFindings()
      .then((next) => {
        if (active) {
          setFindings(next)
          setError(null)
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setError(
            failure instanceof Error
              ? failure.message
              : translate('settings.cli.pathDoctor.failed', 'Failed to inspect PATH folders.')
          )
        }
      })
    return () => {
      active = false
    }
  }, [refreshKey])
  if (error) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {error}
      </p>
    )
  }
  if (findings.length === 0) {
    return null
  }
  return (
    <div role="alert" className="space-y-2 rounded-md border border-border p-3 text-xs">
      <p className="font-medium text-destructive">
        {translate(
          'settings.cli.pathDoctor.unsearchable',
          'This app cannot search these PATH folders:'
        )}
      </p>
      {findings.map((finding) => (
        <div key={finding.path} className="space-y-1">
          <code className="break-all">{finding.path}</code>
          {finding.blockedBy && (
            <p className="break-all text-muted-foreground">
              {translate('settings.cli.pathDoctor.blockedAt', 'Blocked at {{path}}', {
                path: finding.blockedBy
              })}
            </p>
          )}
          <p className="text-muted-foreground">
            {translate(
              'settings.cli.pathDoctor.metadata',
              'Mode {{mode}}; owner UID {{uid}}, GID {{gid}}.',
              {
                mode: finding.mode ?? 'unknown',
                uid: String(finding.ownerUid ?? 'unknown'),
                gid: String(finding.ownerGid ?? 'unknown')
              }
            )}
          </p>
          <p>
            {translate('settings.cli.pathDoctor.fix', 'Suggested fix:')}{' '}
            <code className="break-all">{finding.fix}</code>
          </p>
        </div>
      ))}
    </div>
  )
}
