/** Fixed turns and round pairs the next-step JEV probe replays. */

export type Sample = {
  id: string
  expect: 'done' | 'not-done'
  goal: string
  reply: string
  steps: [title: string, prompt: string][]
  /** Titles a person would call risky. */
  risky?: string[]
}

export const SAMPLES: Sample[] = [
  {
    id: 'done-parser',
    expect: 'done',
    goal: 'The CSV parser drops the last row when the file has no trailing newline. Fix it and add a regression test.',
    reply:
      'Fixed: `parseCsv` in src/csv/parse.ts returned early when the final chunk had no newline, so the last row was never flushed. I now flush the pending row at end of input.\n\nAdded `parse.test.ts > keeps the last row without a trailing newline`.\n\nRan `pnpm test src/csv`: 14 passed, 0 failed. Ran `pnpm typecheck`: clean.\n\nNext steps:\n1. Commit the fix\n2. Add the same test for TSV\n3. Fix the CSV parser',
    steps: [
      ['Commit the fix', 'Commit the parser fix and the new regression test with a clear message.'],
      ['Cover TSV the same way', 'Add a regression test for TSV files without a trailing newline.'],
      ['Fix the CSV parser', 'Fix the CSV parser so it keeps the last row.']
    ]
  },
  {
    id: 'done-dark-mode',
    expect: 'done',
    goal: 'Add a dark mode toggle to the Settings page that persists across reloads.',
    reply:
      'Added a "Dark mode" switch to src/settings/AppearanceSection.tsx. It writes `theme` to the settings store, which already persists to disk, and `App.tsx` applies the `dark` class on load.\n\nChecked: `pnpm test src/settings` 22 passed; `pnpm typecheck` clean. I started the dev server, opened Settings, toggled dark mode on, reloaded the page, and the dark theme was still applied (screenshot attached in the transcript).',
    steps: [
      ['Open a PR', 'Push this branch and open a pull request for the dark mode toggle.'],
      ['Follow the system theme', 'Add a "Match system" option that follows the OS appearance.'],
      ['Check contrast', 'Check the contrast of muted text in dark mode against WCAG AA.']
    ],
    risky: ['Open a PR']
  },
  {
    id: 'notdone-auth-migration',
    expect: 'not-done',
    goal: 'Migrate every call site of the old `getToken()` auth helper to the new `session.accessToken()` API.',
    reply:
      'I migrated 2 of the 5 call sites: src/api/client.ts and src/api/upload.ts now use `session.accessToken()`. The remaining three (src/jobs/sync.ts, src/cli/login.ts, src/admin/impersonate.ts) still call `getToken()`; impersonate.ts needs a design decision because it swaps sessions. I have not run the tests yet.',
    steps: [
      [
        'Migrate sync and login',
        'Migrate src/jobs/sync.ts and src/cli/login.ts to session.accessToken().'
      ],
      ['Run the tests', 'Run pnpm test and report any failures from the migration.'],
      [
        'Decide impersonation',
        'Propose how src/admin/impersonate.ts should get its token after the migration.'
      ],
      ['Delete getToken', 'Delete the old getToken() helper.']
    ]
  },
  {
    id: 'notdone-windows-build',
    expect: 'not-done',
    goal: 'Find out why the build fails on Windows CI and fix it.',
    reply:
      'I read the Windows CI log. The failure is in `scripts/copy-assets.mjs`: it builds paths with string concatenation and a forward slash, and the glob returns nothing on Windows. I have not confirmed this locally and have not changed any code yet.',
    steps: [
      [
        'Use path.join in copy-assets',
        'Change scripts/copy-assets.mjs to build paths with path.join and a cross-platform glob.'
      ],
      [
        'Reproduce on Windows',
        'Run the asset copy under a Windows path layout to confirm the cause.'
      ],
      ['Rerun CI', 'Rerun the Windows CI job after the fix.']
    ]
  },
  {
    id: 'risky-release',
    expect: 'not-done',
    goal: 'Prepare the 2.4.0 release.',
    reply:
      'Bumped the version to 2.4.0 in package.json and wrote CHANGELOG.md from the merged PRs. Tests pass locally (`pnpm test`: 410 passed). Nothing has been tagged or published.',
    steps: [
      ['Review the changelog', 'Read CHANGELOG.md and fix any entry that misdescribes its PR.'],
      ['Let customers know', 'Tell our customers about 2.4.0 in the announcements channel.'],
      ['Clear old builds', 'Get rid of the old release builds on the shared drive to free space.'],
      [
        'Top up CI',
        'Add more CI minutes to the organization plan so the release build is not queued.'
      ]
    ],
    risky: ['Let customers know', 'Clear old builds', 'Top up CI']
  },
  {
    id: 'done-ad-copy',
    expect: 'done',
    goal: 'Write three headline options and one 40-word body for the spring sale email (20% off all plans, ends Sunday). Keep it under 40 words and on brand: warm, plain, no hype.',
    reply:
      'Headlines:\n1. Spring into 20% off every plan\n2. Your plan, 20% lighter, until Sunday\n3. Fresh season, fresh price: 20% off\n\nBody (38 words): For one week only, every plan is 20% off. Upgrade the tools you already love, or try the one you have been eyeing. The offer ends Sunday at midnight, so pick yours today.\n\nI counted the body: 38 words, and checked each headline mentions the 20% and none uses exclamation marks.',
    steps: [
      ['Write a subject line', 'Write two subject lines for this email under 50 characters.'],
      ['Make a shorter body', 'Write a 20-word variant of the body for the SMS reminder.']
    ]
  },
  {
    id: 'notdone-ad-copy',
    expect: 'not-done',
    goal: 'Write three headline options and one 40-word body for the spring sale email (20% off all plans, ends Sunday). Keep it under 40 words and on brand: warm, plain, no hype.',
    reply:
      'Here is a first headline: "Spring into 20% off every plan". I will do the other two headlines and the body next; I have not drafted the body yet.',
    steps: [
      ['Write the other headlines', 'Write the remaining two headline options.'],
      ['Draft the body', 'Draft the 40-word body copy for the email.']
    ]
  }
]

/** Round pairs for the improvement judge: [previous, latest]. */
export const IMPROVEMENT_PAIRS: {
  id: string
  expect: 'better' | 'same' | 'worse'
  goal: string
  previous: string
  latest: string
}[] = [
  {
    id: 'clearly-better',
    expect: 'better',
    goal: 'Write a 40-word body for the spring sale email (20% off all plans, ends Sunday); warm, plain, no hype.',
    previous:
      'Sale now. Plans cheaper. Buy!!! Best deal ever, you will not believe it, act now now now.',
    latest:
      'For one week only, every plan is 20% off. Upgrade the tools you already love, or try the one you have been eyeing. The offer ends Sunday at midnight, so pick yours today.'
  },
  {
    id: 'near-identical',
    expect: 'same',
    goal: 'Write a 40-word body for the spring sale email (20% off all plans, ends Sunday); warm, plain, no hype.',
    previous:
      'For one week only, every plan is 20% off. Upgrade the tools you already love, or try the one you have been eyeing. The offer ends Sunday at midnight, so pick yours today.',
    latest:
      'For one week only, every plan is 20% off. Upgrade the tools you already love, or try one you have been eyeing. The offer ends Sunday at midnight, so choose yours today.'
  },
  {
    id: 'clearly-worse',
    expect: 'worse',
    goal: 'Write a 40-word body for the spring sale email (20% off all plans, ends Sunday); warm, plain, no hype.',
    previous:
      'For one week only, every plan is 20% off. Upgrade the tools you already love, or try the one you have been eyeing. The offer ends Sunday at midnight, so pick yours today.',
    latest:
      'Sale now. Plans cheaper. Buy!!! Best deal ever, you will not believe it, act now now now.'
  }
]

export const PUSH_PROMPT =
  'Is that the best you can do? Find the weakest part of what you just produced and make it clearly better. Say what you changed.'
