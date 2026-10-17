import { useSessionTags } from '@/store/session-tags'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
export function SessionTagFilterSummary() {
  const tagStore = useSessionTags()
  return (
    <>
      {tagStore.data.filter.length ? (
        <div className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs">
          <span className="min-w-0 flex-1 truncate">
            {translate('sessionTags.filtered', 'Filtered by: {{tags}}', {
              tags: tagStore.data.tags
                .filter((tag) => tagStore.data.filter.includes(tag.id))
                .map((tag) => tag.name)
                .join(', ')
            })}
          </span>
          <Button variant="ghost" size="xs" onClick={() => tagStore.setFilter([])}>
            {translate('sessionTags.clear', 'Clear filters')}
          </Button>
        </div>
      ) : null}
    </>
  )
}
