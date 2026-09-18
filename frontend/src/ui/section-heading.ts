/* The row every panel and section opens with: a title on the left, an optional note, chip or
   action on the right. Class strings rather than a component, because the title is an h2 on one
   screen, an h3 on another and a back link plus heading on a third. */
export const sectionHeadingClassName = 'mb-[21px] flex items-center justify-between gap-[12px]'
/** An h2 inside the row. An h3 keeps its base size. */
export const sectionTitleClassName = 'text-[16px]'
/** The small caption on the right of the row. */
export const sectionCaptionClassName =
  'text-micro tracking-[1.2px] text-faint max-phone:text-caption'
