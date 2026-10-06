import { createRoot } from 'react-dom/client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { router } from './app/routes'
import { startTheme } from './theme/store'

import './style.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
})

const root = document.getElementById('root')
if (!root) throw new Error('Missing application root')
// Before the first render, so the tree never paints against the wrong palette. The boot script in
// <head> has already put a saved theme on <html>; this is what takes ownership of it.
startTheme()
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
)
