// Why: the strip shrink-wraps its tabs, so a content-derived width lets one live title update
// resize every tab; a definite width pins them and flex-shrink still narrows to the floor.
export const TAB_CONTAINER_WIDTH_CLASSES = 'w-[180px] min-w-[88px] min-[1280px]:w-[220px]'

export const TAB_LABEL_WIDTH_CLASSES = 'min-w-0 flex-1 truncate'

// Why: the character budget handed to tabTitleLabel. It is what a 220px tab can show, so the
// function's end truncation never bites before CSS `truncate` does — width still rules for
// lone titles — while a shared-prefix family gets its tail budget from the same number.
export const TAB_LABEL_MAX_CHARS = 24
