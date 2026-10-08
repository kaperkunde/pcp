import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** "3 min ago", "2 h ago", "4 d ago": how long since, from the reader's clock. */
export function timeAgo(value: Date | string, now = Date.now()): string {
  const minutes = Math.round((now - new Date(value).getTime()) / 60_000)

  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.round(minutes / 60)

  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}
