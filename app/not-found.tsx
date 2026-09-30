import Link from "next/link"

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-20 text-center">
      <h1 className="text-2xl">Not here</h1>
      <p className="text-muted-foreground">There is nothing at this address.</p>
      <Link href="/" className="text-primary hover:underline">
        Back to PCP
      </Link>
    </main>
  )
}
