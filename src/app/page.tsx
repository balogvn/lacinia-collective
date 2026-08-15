import Link from 'next/link'
import { LiveTerminal } from '@/components/landing/LiveTerminal'

const NAV = [
  { label: 'How it works', href: '/guide' },
  { label: 'Identity', href: '/identity' },
  { label: 'Aid', href: '/aid' },
  { label: 'Deliberate', href: '/deliberate' },
  { label: 'Docs', href: '/identity#docs' },
]

export default function HomePage() {
  return (
    <main className="flex min-h-dvh flex-col">
      {/* ── nav ─────────────────────────────────────────────────────── */}
      <header className="border-b border-paper/30">
        <nav className="mx-auto flex max-w-[1600px] items-center gap-6 px-5 py-5 sm:px-10">
          <ul className="hidden items-center gap-7 lg:flex">
            {NAV.map((item) => (
              <li key={item.label}>
                <Link
                  href={item.href}
                  className="font-mono text-[11px] uppercase tracking-wider text-paper-dim transition-colors hover:text-paper"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>

          <Link
            href="/"
            className="font-mono text-[13px] uppercase tracking-widest text-paper lg:absolute lg:left-1/2 lg:-translate-x-1/2"
          >
            Lacinia<span className="text-paper-dim">.collective</span>
          </Link>

          <Link href="/aid" className="btn ml-auto">
            Open the commons
          </Link>
        </nav>
      </header>

      {/* ── hero ────────────────────────────────────────────────────── */}
      <section className="mx-auto w-full max-w-[1600px] flex-1 px-5 pb-10 pt-12 sm:px-10 sm:pt-16">
        <p className="eyebrow">Offline-first · Peer-vouched · Metered in time</p>

        {/*
          Sized so "TRUST WITHOUT" holds a single line at every breakpoint —
          the phrase breaking mid-sentence reads as a layout bug, not a
          typographic choice. `text-balance` guards the narrow end.
        */}
        <h1 className="scanlines display-tight mt-7 text-balance font-display text-[clamp(2.75rem,10vw,9.5rem)] uppercase text-paper">
          Trust without
          <br />
          signal
        </h1>

        <div className="mt-10 flex flex-wrap items-center gap-3">
          {/*
            Points at the commons, not at /identity. Reading needs no key —
            runSync() has never taken one — so sending a first-time visitor to
            make a keypair put a ceremony in front of the thing they came to
            look at. The commons page offers the one tap that fills it.
          */}
          <Link href="/aid" className="btn btn-solid">
            Open the commons <span aria-hidden>→</span>
          </Link>
          <Link href="/guide" className="btn">
            How it works
          </Link>
          <Link href="/identity#docs" className="btn">
            About
          </Link>
        </div>

        <div className="mt-16 grid gap-10 lg:mt-24 lg:grid-cols-2 lg:items-end lg:gap-16">
          <p className="max-w-xl font-mono text-[13px] uppercase leading-relaxed tracking-wider text-paper-dim">
            Lacinia runs entirely on your phone. Look around with nothing at all — no email, no
            password, no account. Make a stamp when you want to post or vouch, earn standing from
            neighbours you meet in person, and trade help in time credits, with the network off.
          </p>

          <div className="lg:justify-self-end lg:w-full lg:max-w-[620px]">
            <LiveTerminal />
          </div>
        </div>
      </section>

      {/* ── footer ──────────────────────────────────────────────────── */}
      <footer className="border-t border-paper/30">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-2 px-5 py-5 font-mono text-[10px] uppercase tracking-wider text-paper-dim sm:flex-row sm:items-center sm:px-10">
          <span>© Lacinia Collective</span>
          <span className="sm:mx-auto">
            No server · No account · Data stays on device · Destroyed only by you
          </span>
          <span>IndexedDB + CRDT</span>
        </div>
      </footer>
    </main>
  )
}
