import type { Ref } from 'react'

import type {
  FilePathContextMenuAction,
  FilePathContextMenuActionKey,
} from './file-path-context-menu'

export const FilePathContextMenu = ({
  position,
  actions,
  onSelect,
  ref,
}: {
  position: { left: number; top: number }
  actions: FilePathContextMenuAction[]
  onSelect: (key: FilePathContextMenuActionKey) => void
  ref?: Ref<HTMLDivElement>
}) => (
  <div
    ref={ref}
    role="menu"
    className="pane-tab-context-menu file-path-context-menu"
    style={{ left: position.left, top: position.top }}
  >
    {actions.map((action) => (
      <button
        key={action.key}
        type="button"
        role="menuitem"
        onClick={() => onSelect(action.key)}
      >
        {action.label}
      </button>
    ))}
  </div>
)
