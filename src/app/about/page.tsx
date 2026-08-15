import Link from 'next/link'

export const metadata = {
  title: 'About · The Lacinia Collective',
  description:
    'The short version: a neighbourhood noticeboard and a record of favours that lives on your phone, with no company in the middle.',
}

/**
 * What "About" should have been.
 *
 * It used to point at /identity#docs, which is a section buried under the
 * identity workbench. Someone clicking About with no identity yet landed on a
 * form asking them to make a keypair, which answers a question they had not
 * asked and not the one they did. This page answers the actual question in the
 * first paragraph and never asks for anything.
 *
 * Written in the guide's voice rather than the app's: sentence case, real
 * paragraphs, system sans. Uppercase mono is fine for labels and unreadable for
 * an explanation.
 */
export default function AboutPage() {
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
            How to use it →
          </Link>
        </nav>
      </header>

      <article className="mx-auto w-full max-w-[820px] flex-1 px-5 py-12 font-sans sm:px-8 sm:py-16">
        <p className="font-mono text-[11px] uppercase tracking-widest text-paper-dim">In short</p>
        <h1 className="mt-4 font-display text-[clamp(2.25rem,7vw,4rem)] uppercase leading-[0.95] text-paper">
          A noticeboard that belongs to the people using it
        </h1>

        <div className="mt-8 space-y-4 text-[17px] leading-relaxed text-paper/85">
          <p>
            Imagine the noticeboard outside a market. People pin up what they can offer and what
            they need. Someone lends a hand, someone else remembers the favour, and the whole thing
            runs on the fact that everybody roughly knows who everybody is.
          </p>
          <p>
            This is that noticeboard, on your phone. The difference is that there is no company
            behind it. Nobody owns it, nobody can switch it off, and nobody is reading over your
            shoulder to sell you something.
          </p>
        </div>

        {/* ── the three things ── */}
        <h2 className="mt-14 font-display text-3xl uppercase text-paper">It does three things</h2>
        <div className="mt-6 space-y-6">
          {[
            {
              n: 'One',
              t: 'People help each other, and the help is counted',
              d: 'You post what you can offer or what you need. When someone helps you, both phones sign it, and the hour is recorded. An hour is an hour: a lawyer’s hour and a cleaner’s hour are worth exactly the same here. It is a time bank, not a market.',
            },
            {
              n: 'Two',
              t: 'A group can work out what it actually thinks',
              d: 'Somebody asks a real question. Everyone writes short statements and agrees or disagrees with each other’s. There is no reply button, so there is nothing to argue with. What the app then shows you is not the most popular opinion but the ones people on opposite sides both agreed with.',
            },
            {
              n: 'Three',
              t: 'You can tell who is who without any ID',
              d: 'Nobody signs up. Your phone makes you a private stamp that only it holds. Standing comes from people who have met you in person saying so, which means it is earned from your neighbours rather than granted by an office.',
            },
          ].map((item) => (
            <div key={item.n} className="border-l-2 border-paper/30 pl-5">
              <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">
                {item.n}
              </p>
              <h3 className="mt-1 font-display text-2xl text-paper">{item.t}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-paper/75">{item.d}</p>
            </div>
          ))}
        </div>

        {/* ── the unusual part ── */}
        <h2 className="mt-14 font-display text-3xl uppercase text-paper">Why it is built oddly</h2>
        <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-paper/75">
          <p>
            It was made for places where the internet is expensive and comes and goes, so it assumes
            you are offline most of the time. Everything lives on your phone and works with the data
            off. When you do get a signal it swaps a small file with a web address, and that is the
            entire network: files on a shared shelf, not a company holding your data.
          </p>
          <p>
            It was also made for places where people who need each other do not always trust each
            other, across language, faith or family lines. That is why the voting screen hides who
            wrote what, why hiding a post needs objections from people on both sides of an argument
            rather than a loud majority, and why translating for a neighbour counts as work you can
            be paid for.
          </p>
        </div>

        {/* ── honest limits ── */}
        <h2 className="mt-14 font-display text-3xl uppercase text-paper">What it cannot do</h2>
        <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-paper/75">
          <p>
            <strong className="text-paper">If you lose your twelve words, it is gone.</strong> There
            is no company to email and no password to reset. That is the cost of nobody holding your
            account.
          </p>
          <p>
            <strong className="text-paper">Nothing translates by itself.</strong> A statement in
            Hausa stays unreadable to a Yorùbá speaker until a person who reads both writes it out.
            The app can point at the work and pay for it, but it cannot do it.
          </p>
          <p>
            <strong className="text-paper">There is nobody to appeal to.</strong> If your neighbours
            hide something you wrote, there is no head office to overrule them. Nothing is ever
            deleted and you can always read it, but there is no referee.
          </p>
          <p>
            <strong className="text-paper">It is empty until people join.</strong> A noticeboard
            with nobody at it is a blank wall. Everything here depends on real people you actually
            know turning up.
          </p>
        </div>

        <div className="mt-14 border-t border-paper/25 pt-8">
          <p className="text-[15px] leading-relaxed text-paper/75">
            The one-sentence version: it is a noticeboard and a record of favours that belongs to
            the people using it, works without the internet, and has nobody in the middle.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/aid" className="btn btn-solid">
              Open the commons <span aria-hidden>→</span>
            </Link>
            <Link href="/guide" className="btn">
              How to use it
            </Link>
            <Link href="/identity#docs" className="btn">
              Technical limits
            </Link>
          </div>
        </div>
      </article>

      <footer className="border-t border-paper/30">
        <div className="mx-auto max-w-[820px] px-5 py-5 font-mono text-[10px] uppercase tracking-wider text-paper-dim sm:px-8">
          No company · No account · Your phone, your data
        </div>
      </footer>
    </main>
  )
}
