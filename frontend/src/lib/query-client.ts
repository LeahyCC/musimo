import { QueryClient } from '@tanstack/react-query'

/** One cache for the page. A name switch clears it so likes and counts cannot leak across. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
})
