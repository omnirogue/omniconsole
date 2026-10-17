import { translate } from '@/i18n/i18n'

// Literal calls keep every conversion branch discoverable by the localization extractor.
export const routineTeamCopy = {
  pending: () =>
    translate(
      'routineToTeam.pending',
      'The team routine was created but is currently OFF. Keep using this Mac copy until enable succeeds.'
    ),
  retryEnable: () => translate('routineToTeam.retryEnable', 'Retry enable'),
  keepLocal: () => translate('routineToTeam.keepLocal', 'Keep using this Mac for now'),
  enableUnconfirmed: () =>
    translate(
      'routineToTeam.enableUnconfirmed',
      'The hub did not confirm that the team routine is active. This Mac copy has not been turned off.'
    ),
  alsoDisable: () =>
    translate(
      'routineToTeam.alsoDisable',
      'Also turn off the team routine before turning this Mac copy back on? Choose Cancel to leave the team routine on and review the warning.'
    ),
  disableUnconfirmed: () =>
    translate(
      'routineToTeam.disableUnconfirmed',
      'The hub did not confirm that the team routine is off. This Mac copy has not been turned on. Try again to choose whether to turn off the team routine or leave it on.'
    ),
  action: () => translate('routineToTeam.action', 'Make this a team routine'),
  title: () => translate('routineToTeam.title', 'Make this a team routine'),
  off: () =>
    translate(
      'routineToTeam.off',
      'The team routine will be turned on right away after creation. This Mac copy is turned off only after the team routine is confirmed active.'
    ),
  consequences: () =>
    translate(
      'routineToTeam.consequences',
      'It will run on the server, not on this Mac. The server AI cannot use files, folders, tools, or logins that exist only on this Mac. This Mac’s copy will be turned off, not deleted, so it doesn’t run twice.'
    ),
  prompt: () => translate('routineToTeam.prompt', 'Instructions'),
  blocked: () =>
    translate(
      'routineToTeam.blocked',
      'This schedule cannot be converted. Change the local schedule before continuing.'
    ),
  company: () => translate('routineToTeam.company', 'Company'),
  department: () => translate('routineToTeam.department', 'Department'),
  choose: () => translate('routineToTeam.choose', 'Choose…'),
  badScope: () =>
    translate(
      'routineToTeam.badScope',
      'Select a company and department with a usable scope. This department name must contain letters or numbers.'
    ),
  ack: () =>
    translate(
      'routineToTeam.ack',
      'I understand these dependencies will not be available on the server.'
    ),
  confirmRisk: () =>
    translate('routineToTeam.confirmRisk', 'Create team routine despite dependencies'),
  project: () => translate('routineToTeam.project', 'This routine is bound to a local project.'),
  host: () => translate('routineToTeam.host', 'This routine uses an external execution host.'),
  workspace: () =>
    translate('routineToTeam.workspace', 'This routine is bound to a specific workspace.'),
  path: () =>
    translate('routineToTeam.path', 'The instructions refer to a machine-local file path.'),
  precheck: () =>
    translate('routineToTeam.precheck', 'The local precheck command will not run on the server.'),
  moved: () => translate('routineToTeam.moved', 'Moved to team'),
  view: () => translate('routineToTeam.view', 'View team routine'),
  restore: () => translate('routineToTeam.restore', 'Turn this Mac copy back on'),
  doubleRun: () =>
    translate(
      'routineToTeam.doubleRun',
      'The team routine is not turned off. Turning this Mac copy back on may run both copies. Continue?'
    ),
  retry: () => translate('routineToTeam.retry', 'Retry turning off this Mac copy'),
  disableFailed: () =>
    translate(
      'routineToTeam.disableFailed',
      'Both copies are now on. This Mac copy still needs to be turned off. Retry below; this will only turn off this Mac copy.'
    ),
  failed: () => translate('routineToTeam.failed', 'The conversion could not be completed.'),
  close: () => translate('routineToTeam.close', 'Close'),
  cancel: () => translate('routineToTeam.cancel', 'Cancel'),
  working: () => translate('routineToTeam.working', 'Creating team routine…'),
  missing: () =>
    translate(
      'routineToTeam.missing',
      'This routine has no schedule. The server requires a cron schedule.'
    ),
  count: () =>
    translate('routineToTeam.count', 'A fixed server clock cannot preserve a limited run count.'),
  until: () =>
    translate('routineToTeam.until', 'A fixed server clock cannot preserve an end date.'),
  position: () =>
    translate(
      'routineToTeam.position',
      'Nth-weekday and position-based schedules cannot be converted.'
    ),
  monthly: () =>
    translate('routineToTeam.monthly', 'Monthly and day-of-month schedules cannot be converted.'),
  yearly: () => translate('routineToTeam.yearly', 'Yearly schedules cannot be converted.'),
  multiple: () =>
    translate(
      'routineToTeam.multiple',
      'Multiple hours or minutes do not reduce to one fixed time.'
    ),
  minuteInterval: () =>
    translate(
      'routineToTeam.minuteInterval',
      'The minute interval is not a clean divisor of an hour.'
    ),
  hourInterval: () =>
    translate('routineToTeam.hourInterval', 'The hour interval is not a clean divisor of a day.'),
  dst: () =>
    translate(
      'routineToTeam.dst',
      'This schedule crosses a daylight-saving change; ask to run it at a fixed UTC time instead.'
    ),
  unknown: () =>
    translate(
      'routineToTeam.unknown',
      "This schedule doesn't reduce to something the server can run on a fixed clock."
    ),
  foldersRetry: () => translate('routineToTeam.foldersRetry', 'Reload companies and departments'),
  unknownStatus: () => translate('routineToTeam.unknownStatus', 'Unknown'),
  localNotice: () =>
    translate('routineToTeam.localNotice', 'To share this routine, move it to Team routines.'),
  created: () =>
    translate(
      'routineToTeam.created',
      'The team routine was turned on. Manage it from Team routines.'
    )
}
