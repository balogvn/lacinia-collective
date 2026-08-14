import Link from 'next/link'
import { MarketWorkbench } from '@/components/market/MarketWorkbench'

export const metadata = {
  title: 'Mutual aid — The Lacinia Collective',
  description:
    'A time-banked resource commons: offer help, ask for help, and settle in time credits where one hour is one hour for everyone.',
}

export default function AidPage() {
  return (
    <main className="flex min-h-dvh flex-col">
      <header className="border-b border-paper/30">
        <nav className="mx-auto flex max-w-[1200px] items-center gap-6 px-5 py-5 sm:px-8">
          <Link href="/" className="font-mono text-[13px] uppercase tracking-widest text-paper">
            Lacinia<span className="text-paper-dim">.collective</span>
          </Link>
          <Link
            href="/deliberate"
            className="ml-auto font-mono text-[10px] uppercase tracking-wider text-paper-dim transition-colors hover:text-paper"
          >
            Deliberate →
          </Link>
        </nav>
      </header>

      <div className="mx-auto w-full max-w-[1200px] flex-1 px-5 py-10 sm:px-8 sm:py-14">
        <MarketWorkbench />
      </div>

      <footer className="border-t border-paper/30">
        <div className="mx-auto max-w-[1200px] px-5 py-5 font-mono text-[10px] uppercase tracking-wider text-paper-dim sm:px-8">
          One hour is sixty credits, whoever works it · Balances always sum to zero
        </div>
      </footer>
    </main>
  )
}
