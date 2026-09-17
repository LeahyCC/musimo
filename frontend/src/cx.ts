/** One entry in a class list: a name, or the falsy result of a condition that did not hold. */
export type ClassName = string | false | null | undefined

/** Joins the class names that survived their conditions. `cx('row', open && 'row-open')`. */
export const cx = (...names: ClassName[]): string => names.filter(Boolean).join(' ')
