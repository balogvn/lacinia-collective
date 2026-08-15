import Link from 'next/link'

export const metadata = {
  title: 'How this works — The Lacinia Collective',
  description:
    'A plain-language guide: what the Lacinia Collective is, how to join, and how helping your neighbours works when there is no company in the middle.',
}

/**
 * The guide deliberately breaks the app's type rules.
 *
 * Everywhere else, body copy is 11px uppercase mono with wide tracking — it
 * suits labels and short lines, and it is genuinely hard to read for more than
 * a sentence. This page exists for someone who was handed a link and does not
 * yet know what any of this is, so readability beats house style: sentence
 * case, ordinary sizes, real paragraphs.
 *
 * It also avoids every word the rest of the app uses. No keypair, no vouch, no
 * anchor, no credits until each is introduced by what it does.
 */

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="border-l-2 border-paper/30 pl-5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-paper/40">Step {n}</p>
      <h3 className="mt-1 font-display text-2xl text-paper">{title}</h3>
      <div className="mt-2 space-y-3 text-[15px] leading-relaxed text-paper/75">{children}</div>
    </li>
  )
}

function Q({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-paper/15 pt-5">
      <h3 className="font-display text-xl text-paper">{q}</h3>
      <div className="mt-2 space-y-3 text-[15px] leading-relaxed text-paper/75">{children}</div>
    </div>
  )
}

export default function GuidePage() {
  return (
    <main className="flex min-h-dvh flex-col">
      <header className="border-b border-paper/30">
        <nav className="mx-auto flex max-w-[820px] items-center gap-6 px-5 py-5 sm:px-8">
          <Link href="/" className="font-mono text-[13px] uppercase tracking-widest text-paper">
            Lacinia<span className="text-paper-dim">.collective</span>
          </Link>
          <Link
            href="/identity"
            className="ml-auto font-mono text-[10px] uppercase tracking-wider text-paper-dim transition-colors hover:text-paper"
          >
            Get started →
          </Link>
        </nav>
      </header>

      {/*
        font-sans here is deliberate. The app inherits font-mono from body,
        which suits labels and short lines but is roughly 40% wider per
        character and measurably slower to read across paragraphs. This page
        exists to be read by someone who does not yet know what any of this is,
        so it uses the system sans stack — still zero bytes over the wire, which
        is the constraint that ruled out webfonts everywhere else.
      */}
      <article className="mx-auto w-full max-w-[820px] flex-1 px-5 py-12 font-sans sm:px-8 sm:py-16">
        <p className="font-mono text-[11px] uppercase tracking-widest text-paper-dim">
          A plain guide
        </p>
        <h1 className="mt-4 font-display text-[clamp(2.5rem,8vw,4.5rem)] uppercase leading-[0.95] text-paper">
          What is this?
        </h1>

        <div className="mt-8 space-y-4 text-[17px] leading-relaxed text-paper/85">
          <p>
            It is a way for people in the same area to help each other — lend a hand, share what
            they have, and decide things together.
          </p>
          <p>
            What makes it unusual is what is <em>not</em> here. There is no company running it. No
            account to sign up for. No password. Nothing is stored on anybody&rsquo;s computer but
            your own phone, and most of it works with your data switched off.
          </p>
        </div>

        {/* ── the three ideas ── */}
        <h2 className="mt-14 font-display text-3xl uppercase text-paper">Three things to know</h2>

        <div className="mt-6 space-y-8">
          <div>
            <h3 className="font-display text-2xl text-paper">Your phone makes you a stamp</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-paper/75">
              When you start, your phone creates a private stamp that only it has. Everything you do
              here gets stamped, so anyone can check it really came from you — and nobody can copy
              it or pretend to be you. You never make a username or a password, because the stamp
              already is you.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-paper/75">
              You will be shown twelve words. <strong className="text-paper">Write them on
              paper.</strong> If your phone is lost or stolen, those words bring your stamp back on
              a new one. Nobody can send them to you — not us, not anyone — because nobody else has
              them.
            </p>
          </div>

          <div>
            <h3 className="font-display text-2xl text-paper">Standing comes from people, not the app</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-paper/75">
              A new stamp means nothing on its own. Anyone can make one in a second, so the app
              gives it no weight at all.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-paper/75">
              You get standing the way you do anywhere else: someone who is already known says
              &ldquo;I know this person.&rdquo; They do it face to face, by holding up a code on
              their phone for yours to read. It is the same as being introduced at a meeting, except
              the introduction is written down and cannot be faked.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-paper/75">
              Standing is what unlocks the more serious things — donated medicine, a shared tool,
              taking help before you have given any.
            </p>
          </div>

          <div>
            <h3 className="font-display text-2xl text-paper">An hour is an hour</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-paper/75">
              Help is counted in time. One hour of anyone&rsquo;s work is sixty credits — a
              lawyer&rsquo;s hour and a cleaner&rsquo;s hour are worth exactly the same. That is on
              purpose. It is a time bank, not a market.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-paper/75">
              Everybody starts at zero. Help someone and you go up; receive help and you go down.
              Being below zero is normal — it just means it is your turn to give something back.
            </p>
          </div>
        </div>

        {/* ── getting started ── */}
        <h2 className="mt-14 font-display text-3xl uppercase text-paper">Getting started</h2>
        <ol className="mt-6 space-y-8">
          <Step n="1" title="Look around first">
            <p>
              Open <Link href="/aid" className="underline underline-offset-4">Mutual aid</Link> and
              tap <em>Add the commons this app came with</em>. That is one tap and it needs nothing
              from you — no name, no number, no account.
            </p>
            <p>
              A commons is just a shared noticeboard: the offers, requests and conversations for an
              area. What arrives is checked on your phone against the signature of whoever wrote it,
              stays on your phone, and works offline from then on.
            </p>
          </Step>

          <Step n="2" title="Make your stamp when you want to join in">
            <p>
              Reading needs nothing. Posting, voting and agreeing an exchange are signed by you, so
              those need a stamp of your own. Open{' '}
              <Link href="/identity" className="underline underline-offset-4">Identity</Link> and
              put in the name people know you by; your phone does the rest in a second.
            </p>
            <p>
              Write down the twelve words before you carry on. This is the one part that cannot be
              undone later.
            </p>
          </Step>

          <Step n="3" title="Get someone to introduce you">
            <p>
              Find someone already using it. On your phone tap <em>Show my code</em>; they tap{' '}
              <em>Vouch for someone</em> and point their camera at your screen. They choose how well
              they know you, and their phone shows a code back for you to read.
            </p>
            <p>
              If you cannot meet, you can send the codes to each other as messages instead — but
              call them and read the short code aloud to each other first, so you both know who you
              are really talking to.
            </p>
          </Step>

        </ol>

        {/* ── what you can do ── */}
        <h2 className="mt-14 font-display text-3xl uppercase text-paper">What you can do</h2>
        <div className="mt-6 space-y-6">
          <div>
            <h3 className="font-display text-xl text-paper">Ask for help, or offer it</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-paper/75">
              Post what you can do or what you need — a bag of rice, an hour of tailoring, a lift to
              the clinic. When the help actually happens, the two of you settle it: one phone shows
              a code, the other agrees. Both of you have to agree, so nobody can charge you for
              something that never happened.
            </p>
          </div>
          <div>
            <h3 className="font-display text-xl text-paper">Work out what people actually think</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-paper/75">
              Someone asks a question — say, how the market levy should be spent. People write short
              statements, and everyone else just agrees or disagrees. There is no replying and no
              arguing, because there is nothing to reply to.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-paper/75">
              The app then finds the groups that really exist and shows you the statements that{' '}
              <strong className="text-paper">everyone agrees with</strong> — not the ones the
              biggest group shouted loudest about. It also shows you honestly where people are
              split.
            </p>
          </div>
          <div>
            <h3 className="font-display text-xl text-paper">Deal with something out of order</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-paper/75">
              You can flag something abusive. But here is the important part: if only one side
              flags it, nothing happens. That is a disagreement, and disagreement already has a
              button. Something is only hidden when people from{' '}
              <strong className="text-paper">every group</strong> object — so one side can never
              silence the other.
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-paper/75">
              Even then it is only folded away, never deleted, and you can always tap to read it.
            </p>
          </div>
        </div>

        {/* ── questions ── */}
        <h2 className="mt-14 font-display text-3xl uppercase text-paper">
          Questions people ask
        </h2>
        <div className="mt-6 space-y-5">
          <Q q="Who is in charge?">
            <p>
              Nobody. There is no owner, no moderator and no admin account — not even for whoever
              built it. There is no login to give anyone that power.
            </p>
            <p>
              The closest thing is a body everybody already knows — a mosque, a parish, a market
              association. Your phone can choose to take their word as a starting point. But it is
              your phone&rsquo;s choice, one by one, and you can undo it whenever you like.
            </p>
          </Q>
          <Q q="What if I lose my phone?">
            <p>
              Your twelve words bring everything back on a new phone. Without them it is gone, and
              nobody can recover it for you. That is the cost of there being no company holding your
              account — write the words down.
            </p>
          </Q>
          <Q q="Does it need internet?">
            <p>
              Only to swap updates with people far away, and only for a moment. Everything else —
              being introduced, posting, settling help, voting — works with your data off. Two
              phones side by side need no network at all.
            </p>
          </Q>
          <Q q="Who can see what I do?">
            <p>
              Anything you post is meant to be shared, so treat it as public. Your private stamp
              never leaves your phone, and you can lock it with a PIN.
            </p>
            <p>
              Nothing is tracked, because there is nowhere to send it. No advertising, no profile
              being built about you.
            </p>
          </Q>
          <Q q="What does it cost?">
            <p>
              Nothing, and there is nobody to charge you. The only cost is the small amount of data
              used when you sync, which is kept deliberately tiny.
            </p>
          </Q>
          <Q q="How do I bring someone in?">
            <p>
              Open <strong>Sync</strong>, then <strong>Sources</strong>, and use{' '}
              <strong>Invite someone</strong>. You get one link. Send it however you already talk,
              or hold the square code up to their camera — their normal camera app opens it, with
              nothing to install first.
            </p>
            <p>
              The link does two things when they open it. It offers to add the noticeboard, which
              is one tap. And it shows them the twelve characters that identify whoever your group
              treats as its starting point — a market association, a parish, a mosque. That second
              part they have to confirm themselves, after checking those characters with you. A
              link is not allowed to decide who someone trusts, and this one does not.
            </p>
          </Q>
          <Q q="Does it only work where I live?">
            <p>
              It works anywhere. You pick your country and type your own area in your own words —
              town, ward, barangay, bairro, estate, whatever you actually call it. Nobody has to fit
              their home into another country&rsquo;s list of names.
            </p>
            <p>
              You are not joining a global network, though. A group is simply the people who sync
              with the same list, so what you see is your own community and not the whole world. If
              your group wants its own noticeboard, anybody can run one — nobody needs permission,
              and there is nobody to ask.
            </p>
          </Q>
        </div>

        <div className="mt-14 border-t border-paper/25 pt-8">
          <p className="text-[15px] leading-relaxed text-paper/75">
            The short version: it is a noticeboard and a record of favours that belongs to the
            people using it, with nobody in the middle.
          </p>
          <Link href="/identity" className="btn btn-solid mt-6">
            Make your stamp <span aria-hidden>→</span>
          </Link>
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
