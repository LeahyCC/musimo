import type { ReactNode } from 'react'

/** The heading block every route opens with: a small eyebrow, the page name, and room for a chip. */
export function PageTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string
  title: string
  children?: ReactNode
}) {
  return (
    <div className="mt-[1px] mb-[23px] flex items-center justify-between gap-[20px] max-phone:flex-wrap max-phone:items-start max-phone:gap-[15px]">
      <div>
        <p className="mb-[12px] text-micro font-semibold tracking-[2px] text-faint max-phone:text-caption">
          {eyebrow}
        </p>
        <h1>{title}</h1>
      </div>
      {children}
    </div>
  )
}
