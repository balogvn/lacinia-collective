import Link from 'next/link'
import { IdentityWorkbench } from '@/components/identity/IdentityWorkbench'

export const metadata = {
  title: 'Identity — The Lacinia Collective',
  description: 'Create a keypair identity and build standing through offline peer vouches.',
}

export default function IdentityPage() {
  return (
    <main className="flex min-h-dvh flex-col">
      <header className="border-b border-paper/30">
        <nav className="mx-auto flex max-w-[1200px] items-center gap-6 px-5 py-5 sm:px-8">
          <Link href="/" className="font-mono text-[13px] uppercase tracking-widest text-paper">
            Lacinia<span className="text-paper-dim">.collective</span>
          </Link>
          <Link
            href="/aid"
            className="ml-auto font-mono text-[10px] uppercase tracking-wider text-paper-dim transition-colors hover:text-paper"
          >
            Mutual aid →
          </Link>
        </nav>
      </header>

      <div className="mx-auto w-full max-w-[1200px] flex-1 px-5 py-10 sm:px-8 sm:py-14">
        <IdentityWorkbench />
      </div>

      <footer className="border-t border-paper/30">
        <div className="mx-auto max-w-[1200px] px-5 py-5 font-mono text-[10px] uppercase tracking-wider text-paper-dim sm:px-8">
          Everything on this page happened on your device · No request left the browser
        </div>
      </footer>
    </main>
  )
}
