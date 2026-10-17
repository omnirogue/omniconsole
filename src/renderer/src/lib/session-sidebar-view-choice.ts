import {
  sessionSidebarLayout,
  withSessionSidebarGroupBy,
  type SESSION_SIDEBAR_LENS_VALUES,
  type SessionSidebarView
} from './session-sidebar-view'

/** Flat sessions are the default; folder and summary views remain optional. */
export type SessionSidebarViewChoice =
  | 'flat'
  | 'focus'
  | 'folders'
  | (typeof SESSION_SIDEBAR_LENS_VALUES)[number]

/** What the View picker shows as chosen: a Group-by view when one is set, else the layout. */
export function sessionSidebarViewChoice(
  view: Pick<SessionSidebarView, 'lens' | 'layout' | 'flat'>
): SessionSidebarViewChoice {
  return (
    view.lens ??
    (view.flat !== false ? 'flat' : sessionSidebarLayout(view) === 'focus' ? 'focus' : 'folders')
  )
}

/** One saved choice: Focus or Folders keep groupBy (status or task); a Group-by view opens in full. */
export function withSessionSidebarViewChoice(
  view: SessionSidebarView,
  choice: SessionSidebarViewChoice
): SessionSidebarView {
  if (choice === 'flat' || choice === 'focus' || choice === 'folders') {
    const { lens: _lens, ...rest } = view
    return { ...rest, flat: choice === 'flat', layout: choice === 'focus' ? 'focus' : 'full' }
  }
  return { ...withSessionSidebarGroupBy(view, choice), flat: false, layout: 'full' }
}
