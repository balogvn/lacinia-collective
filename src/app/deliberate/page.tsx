import Link from 'next/link'
import { DeliberationWorkbench } from '@/components/deliberate/DeliberationWorkbench'

export const metadata = {
  title: 'Deliberation — The Lacinia Collective',
  description:
    'Agree or disagree on local statements. No replies, no threads — the app surfaces what bridges groups rather than what wins inside one.',
}

export default function DeliberatePage() {
  return (
    <main className="flex min-h-dvh flex-col">
      <header className="border-b border-paper/30">
        <nav className="mx-auto flex max-w-[1200px] items-center gap-6 px-5 py-5 sm:px-8">
          <Link href="/" className="font-mono text-[13px] uppercase tracking-widest text-paper">
            Lacinia<span className="text-paper-dim">.collective</span>
          </Link>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-paper-dim">
            Augmented deliberation
          </span>
        </nav>
      </header>

      <div className="mx-auto w-full max-w-[1200px] flex-1 px-5 py-10 sm:px-8 sm:py-14">
        <DeliberationWorkbench />
      </div>

      <footer className="border-t border-paper/30">
        <div className="mx-auto max-w-[1200px] px-5 py-5 font-mono text-[10px] uppercase tracking-wider text-paper-dim sm:px-8">
          No replies · No threads · Statements that bridge groups rise above statements that win
          inside one
        </div>
      </footer>
    </main>
  )
}
