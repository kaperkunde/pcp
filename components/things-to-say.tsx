/**
 * What to say to an assistant once PCP is added to it (#163): talking to it
 * is a way to use PCP of its own, and it sets up what PCP can do when asked,
 * proposing it for you to approve. Shown wherever the first steps end.
 */
export const THINGS_TO_SAY = [
  "I'd like to add my Gmail",
  "Can you connect to my printer?",
  "I'd like to set up an SSH connection to my server so I can host things",
] as const

export function ThingsToSay({ className }: { className?: string }) {
  return (
    <ul
      className={className ?? "flex flex-col gap-2 text-[15px]"}
      data-testid="things-to-say"
    >
      {THINGS_TO_SAY.map((sentence) => (
        <li key={sentence}>
          <q className="font-medium">{sentence}</q>
        </li>
      ))}
    </ul>
  )
}
