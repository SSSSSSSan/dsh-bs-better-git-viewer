/**
 * Icons beyond the primitives set (copied from dsh-better-sidebar's own
 * icon set, MIT): the terminal glyph in the app's outline style.
 */
import type { ReactNode } from 'react'

interface IconProps {
  size?: number
  className?: string
}

/** Terminal glyph: a rounded frame with a prompt chevron and underscore cursor. */
export function IconTerminalOutline16({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 6.25 6.75 8 4.5 9.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 10.4h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
