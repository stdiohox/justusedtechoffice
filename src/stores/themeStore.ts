import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

interface ThemeState {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
  /** Recomputes from the current system preference. Called on rehydrate. */
  sync: () => void
}

const STORAGE_KEY = 'jut-office-theme'

const systemTheme = (): ResolvedTheme =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'

const resolve = (theme: Theme): ResolvedTheme =>
  theme === 'system' ? systemTheme() : theme

const apply = (resolved: ResolvedTheme) => {
  document.documentElement.setAttribute('data-theme', resolved)
  // Lets the browser paint form controls and scrollbars to match.
  document.documentElement.style.colorScheme = resolved
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      resolvedTheme: 'light',
      setTheme: (theme) => {
        const resolved = resolve(theme)
        apply(resolved)
        set({ theme, resolvedTheme: resolved })
      },
      sync: () => {
        const resolved = resolve(get().theme)
        apply(resolved)
        set({ resolvedTheme: resolved })
      },
    }),
    {
      name: STORAGE_KEY,
      // resolvedTheme is derived. Persisting it would let a stale value
      // outlive a change in the OS setting between sessions.
      partialize: (s) => ({ theme: s.theme }),
      onRehydrateStorage: () => (state) => state?.sync(),
    },
  ),
)

/**
 * Keeps 'system' honest while the app is open. Only re-resolves when the user
 * has not made an explicit choice.
 */
if (typeof window !== 'undefined') {
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (useThemeStore.getState().theme === 'system') useThemeStore.getState().sync()
    })
}
