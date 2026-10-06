import type { ReactNode } from 'react'

/** The lettered tile that stands for a download source, in Settings and in Diagnostics. */
export function SourceMark({ children }: { children: ReactNode }) {
  return (
    <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[8px] bg-partial-bg text-[26px] font-[650] text-partial">
      {children}
    </span>
  )
}
