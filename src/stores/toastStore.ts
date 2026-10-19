import { create } from 'zustand'

export type ToastType = 'success' | 'info' | 'error'

export interface ToastMessage {
  /** Changes on every show, so the component can restart its entrance. */
  id: number
  message: string
  type: ToastType
}

interface ToastState {
  toast: ToastMessage | null
  showToast: (message: string, type?: ToastType) => void
  hideToast: () => void
}

/**
 * Module-scoped, because the timer belongs to the store and not to any one
 * toast. Without clearing it, a second toast raised three seconds after the
 * first is dismissed by the first one's timer after only one second.
 */
let dismissTimer: ReturnType<typeof setTimeout> | undefined

export const useToastStore = create<ToastState>((set) => ({
  toast: null,
  showToast: (message, type = 'info') => {
    if (dismissTimer) clearTimeout(dismissTimer)
    set({ toast: { id: Date.now(), message, type } })
    dismissTimer = setTimeout(() => set({ toast: null }), 4000)
  },
  hideToast: () => {
    if (dismissTimer) clearTimeout(dismissTimer)
    set({ toast: null })
  },
}))
