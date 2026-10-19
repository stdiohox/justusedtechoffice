import { QueryClient } from '@tanstack/react-query'

/**
 * The one query cache. A module of its own so the auth store can clear it
 * when someone signs out or another person signs in on the same browser:
 * nothing read for one person may show for the next.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})
