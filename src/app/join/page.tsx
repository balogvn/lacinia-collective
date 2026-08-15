import Link from 'next/link'
import { JoinFlow } from '@/components/join/JoinFlow'

export const metadata = {
  title: 'Join a commons — The Lacinia Collective',
  description:
    'Someone shared a commons with you. Add it to your device in one tap — no account, no email, no password.',
}

/**
 * The page an invite link lands on.
 *
 * It is a route of its own rather than a mode of the identity page for two
 * reasons. The address says what it is, which matters when the link is read
 * aloud down a phone line or printed under a QR code on a market wall. And the
 * recipient may never have seen this app before — arriving in the middle of a
 * workbench full of fingerprints and trust tiers would be its own kind of
 * refusal.
 */
export default function JoinPage() {
  return (
    <main className="flex min-h-dvh flex-col">
      <header className="border-b border-paper/30">
        <nav className="mx-auto flex max-w-[820px] items-center gap-6 px-5 py-5 sm:px-8">
          <Link href="/" className="font-mono text-[13px] uppercase tracking-widest text-paper">
            Lacinia<span className="text-paper-dim">.collective</span>
          </Link>
          <Link
            href="/guide"
            className="ml-auto font-mono text-[10px] uppercase tracking-wider text-paper-dim transition-colors hover:text-paper"
          >
            What is this? →
          </Link>
        </nav>
      </header>

      <div className="mx-auto w-full max-w-[820px] flex-1 px-5 py-10 sm:px-8 sm:py-14">
        <JoinFlow />
      </div>

      <footer className="border-t border-paper/30">
        <div className="mx-auto max-w-[820px] px-5 py-5 font-mono text-[10px] uppercase tracking-wider text-paper-dim sm:px-8">
          No account · No email · Nothing is added without your say-so
        </div>
      </footer>
    </main>
  )
}
