import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { JEV_CONTROL_METHODS, type JevHostStatus } from '../../../../shared/jev-control'
import type { JevTrialResult } from '../../../../shared/jev-trial-workflow'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'

export function JevFrameworkSettings({
  settings
}: {
  settings: GlobalSettings
}): React.JSX.Element {
  const environmentId = settings.activeRuntimeEnvironmentId ?? null
  const [status, setStatus] = useState<JevHostStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [task, setTask] = useState('')
  const [result, setResult] = useState<JevTrialResult | null>(null)
  const generation = useRef(0)
  const target = () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId })

  const refresh = useCallback(async () => {
    const at = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const next = await callRuntimeRpc<JevHostStatus>(
        getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
        JEV_CONTROL_METHODS.status,
        {}
      )
      if (at === generation.current) {
        setStatus(next)
      }
    } catch {
      if (at === generation.current) {
        setStatus(null)
        setError(
          translate(
            'jev.controlsUnavailable',
            'JEV controls are unavailable on this host. Update or reconnect it, then refresh.'
          )
        )
      }
    } finally {
      if (at === generation.current) {
        setBusy(false)
      }
    }
  }, [environmentId])

  useEffect(() => {
    setStatus(null)
    setResult(null)
    void refresh()
    const owner = generation
    return () => {
      owner.current++
    }
  }, [refresh])

  const change = async (enabled: boolean) => {
    const at = ++generation.current
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const next = await callRuntimeRpc<JevHostStatus>(target(), JEV_CONTROL_METHODS.configure, {
        enabled
      })
      if (at === generation.current) {
        setStatus((previous) => ({ ...previous, ...next }))
      }
    } catch {
      if (at === generation.current) {
        setError(
          translate(
            'jev.saveFailed',
            'The change was not confirmed. Refresh to read the host before trying again.'
          )
        )
      }
    } finally {
      if (at === generation.current) {
        setBusy(false)
      }
    }
  }

  const ask = async () => {
    const at = ++generation.current
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      const response = await callRuntimeRpc<{ result: JevTrialResult }>(
        target(),
        JEV_CONTROL_METHODS.request,
        {
          input: { recipeId: 'work_routing', state: { task: task.trim() } },
          control: 'request'
        }
      )
      if (at === generation.current) {
        setResult(response.result)
      }
    } catch {
      if (at === generation.current) {
        setError(
          translate(
            'jev.requestFailed',
            'No JEV result was confirmed. No fallback model was called.'
          )
        )
      }
    } finally {
      if (at === generation.current) {
        setBusy(false)
      }
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label htmlFor="jev-host-switch">
            {translate('jev.hostTitle', 'JEV on the selected host')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'jev.hostHint',
              'Controls JEV calls from this app. Feature switches still apply. LLM escalation is configured separately.'
            )}
          </p>
        </div>
        <Switch
          id="jev-host-switch"
          checked={status?.enabled ?? false}
          disabled={busy || !status}
          onCheckedChange={(enabled) => {
            void change(enabled)
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {status
            ? status.effective === 'off'
              ? translate('jev.off', 'JEV is off')
              : status.credentialConfigured
                ? translate('jev.ready', 'JEV is available')
                : translate('jev.needsKey', 'JEV needs a TypeSafe connection')
            : translate('jev.unknown', 'Host status unknown')}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            void refresh()
          }}
        >
          {translate('jev.refresh', 'Refresh')}
        </Button>
      </div>
      {status?.environmentDisabled ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'jev.environmentOff',
            'An environment kill switch keeps JEV off even when this setting is enabled.'
          )}
        </p>
      ) : null}
      <Label htmlFor="jev-preview-task">
        {translate('jev.previewTask', 'Ask JEV to suggest a route for a task')}
      </Label>
      <Textarea
        id="jev-preview-task"
        value={task}
        maxLength={6000}
        disabled={busy}
        onChange={(event) => {
          setTask(event.target.value)
          setResult(null)
        }}
        placeholder={translate('jev.taskPlaceholder', 'Describe the task and relevant facts.')}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={busy || status?.effective !== 'on' || !task.trim()}
        onClick={() => {
          void ask()
        }}
      >
        {translate('jev.ask', 'Ask JEV once')}
      </Button>
      <p className="text-xs text-muted-foreground">
        {translate(
          'jev.advisory',
          'This uses JEV only and returns advice. It does not launch work, call a fallback LLM, or change any setting.'
        )}
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {result?.status === 'unavailable' ? (
        <p role="status" className="text-xs">
          {translate('jev.noReading', 'No usable reading. No action was taken.')} ({result.reason})
        </p>
      ) : null}
      {result?.status === 'success' ? (
        <div className="space-y-1 text-xs" role="status">
          <p>
            {translate('jev.adviceOnly', 'Advisory reading — confidence is not verified accuracy.')}
          </p>
          {Object.entries(result.answers).map(([id, answer]) => (
            <p key={id}>
              <span className="font-medium">{id.replaceAll('_', ' ')}: </span>
              {answer.type === 'choice'
                ? translate('jev.choiceReading', '{{choice}} ({{confidence}}% model confidence)', {
                    choice: answer.choice.replaceAll('_', ' '),
                    confidence: Math.round(answer.confidence * 100)
                  })
                : answer.type === 'score'
                  ? translate('jev.scoreReading', '{{score}} ({{confidence}}% model confidence)', {
                      score: answer.score.toFixed(2),
                      confidence: Math.round(answer.confidence * 100)
                    })
                  : translate('jev.noulReading', '{{answer}} (P yes {{probability}}%)', {
                      answer:
                        answer.noul >= 0.9
                          ? translate('jev.yesAnswer', 'YES')
                          : answer.noul <= 0.1
                            ? translate('jev.noAnswer', 'NO')
                            : translate('jev.unknownAnswer', 'UNKNOWN'),
                      probability: Math.round(answer.noul * 100)
                    })}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
