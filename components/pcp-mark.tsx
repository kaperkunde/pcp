/** The logo: a keyhole in a tile. */
export function PcpMark({ className = "size-8" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <circle cx="16" cy="12.5" r="4.5" fill="var(--primary-foreground)" />
      <path
        d="M13.5 15.5h5l1.5 8.5h-8l1.5-8.5z"
        fill="var(--primary-foreground)"
      />
    </svg>
  )
}
