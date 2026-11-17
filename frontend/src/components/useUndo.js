import { useCallback } from 'react'
import { api, notifyChanged } from '../api'
import { useToast } from '../context'

/**
 * After a delete, show a toast with an "Undo" button that restores the item from the recycle bin.
 * kind: issue | feature | release | document | risk | milestone | project
 */
export function useUndoDelete() {
  const toast = useToast()
  return useCallback(
    (kind, id, label, onRestored) => {
      toast(`${label} moved to the recycle bin`, 'success', {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await api(`/trash/${kind}/${id}/restore`, { method: 'POST' })
              toast(`${label} restored`)
              notifyChanged()
              onRestored?.()
            } catch (err) {
              toast(err.message, 'error')
            }
          },
        },
      })
    },
    [toast],
  )
}
