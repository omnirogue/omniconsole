import type { ConsoleDriveIntake } from '../../../../shared/console-drive-contract'
import { translate } from '@/i18n/i18n'

export function DriveIntakeList({ rows }: { rows: ConsoleDriveIntake[] }) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium">
        {translate('drive.requestsCount', 'File requests · {{count}}', { count: rows.length })}
      </h4>
      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.task.drive.DriveIntakeList.46c0bbb9a5',
            'No file requests recorded.'
          )}
        </p>
      )}
      <ol className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.id} className="space-y-1 py-2 text-xs">
            <p>
              {row.expected_from_email ||
                row.expected_from ||
                translate(
                  'auto.components.task.drive.DriveIntakeList.4d92339185',
                  'Any sender'
                )}{' '}
              · {row.pattern}
            </p>
            <p className="text-muted-foreground">
              {row.status} ·{' '}
              {row.expected_count
                ? translate(
                    'auto.components.task.drive.DriveIntakeList.c1a80bcb3e',
                    '{{value0}} of {{value1}} files',
                    { value0: row.arrivals, value1: row.expected_count }
                  )
                : translate(
                    'auto.components.task.drive.DriveIntakeList.d1549facb5',
                    '{{value0}} files',
                    { value0: row.arrivals }
                  )}
            </p>
            {row.files.length > 0 && (
              <ul className="space-y-1">
                {row.files.map((file) => (
                  <li key={`${file.file_id}:${file.first_seen_at}`}>
                    {file.link ? (
                      <a href={file.link} target="_blank" rel="noreferrer" className="underline">
                        {file.name}
                      </a>
                    ) : (
                      file.name
                    )}
                    {' · '}
                    {translate('drive.fileSizeState', '{{bytes}} bytes · {{state}}', {
                      bytes: new Intl.NumberFormat().format(file.size_bytes),
                      state: file.disposition
                    })}
                    <span className="block text-muted-foreground">
                      {file.sender_email ||
                        file.sender_id ||
                        translate(
                          'auto.components.task.drive.DriveIntakeList.ee83e9fbe1',
                          'Sender not reported'
                        )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
