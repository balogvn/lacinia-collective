# The Lacinia Collective

An offline-first digital commons for mutual aid — peer-vouched identity, time-banked resources, and
civic deliberation that works with the network off, anywhere in the world.

It was designed against Nigerian conditions — metered data, patchy signal, low-end Android, and a
real need to build trust across ethno-religious lines — because designing for the hardest case is
the only way to know the easy ones are covered. Nothing in it is Nigeria-only: a place is a country
code plus whatever you call your own area, and any group anywhere can run its own commons without
asking anyone for permission. See [Running your own commons](#running-your-own-commons).

Built on the *Plurality* premise that legitimacy comes from relationships across difference rather
than from a platform. Practically, that means there is no server, no account and no central list of
who counts.

> **Status: Tasks 1–4 complete, plus moderation.** Identity, offline vouching, sync, time-banked
> mutual aid, augmented deliberation, and the moderation and revocation layer are all built and
> verified. See [Roadmap](#roadmap) for what remains.

---

## Quick start

```bash
npm install
```

```bash
npm run verify
```

```bash
npm run dev
```

`npm run verify` runs 504 adversarial checks headlessly in a few seconds. Run it first — if the
engines are sound, everything above them is a rendering problem.

To try sync against a real static commons:

```bash
npx tsx scripts/seed-commons.mts && npm run aggregate && npm run dev
```

Then add `http://localhost:3000/commons/` as a source in **Sync → Sources**.

---

## Try the live demo

**https://balogvn.github.io/lacinia-collective/**

The app and its commons are served from the same origin, so the sync source is
same-origin and needs no CORS anywhere.

1. **Create an identity** at `/identity` — twelve words, no email, no password.
2. **Add the demo commons** under *Sync → Sources*:

   ```
   https://balogvn.github.io/lacinia-collective/commons/
   ```

   Press **Sync now**. About 190 signed ops arrive: three identities, two
   vouchers, four listings, and a 21-person deliberation.
3. **Trust the demo anchor** under *Anchors → Manage*, or every score stays at
   zero and the trust ladder looks broken. Anchors are the axioms of the graph
   and are deliberately never shipped in the app — each device chooses its own.
   This one is a throwaway used to make the sample data legible; the real root
   is in [The founding anchor](#the-founding-anchor):

   ```
   gWVqfrhfO_YWrXDFglNL2snYl6Tb6drT7md7BO70qF8
   ```

   Fingerprint `FHMM-XV88-8TRN`. Paste the key, then reopen `/identity`.

Then `/deliberate` shows the moderation layer doing the thing it exists for:

| Statement | Flags | Outcome |
|---|---|---|
| "The lock-up owners decide everything among themselves" | **14**, all from one bloc | **Visible** |
| "The lock-up crowd are thieves…" | **10**, from both blocs | **Withheld** |

More flags survives; fewer flags corroborated across the divide does not.

> The demo data is synthetic — throwaway keys, invented traders, an invented
> market levy. Its anchor key was generated during a seed run and its secret was
> never kept, so nobody can act as it. That is fine for illustration and useless
> as a root of trust, which is what the next section is for.

---

## The founding anchor

The demo anchor above exists only to make the sample conversation show trust
working. The real root of this commons is a key someone actually holds:

```
gB7qR0vuqtKJHQspmakOU0gVIBrF-fH8Y3llRP_x56I
```

Fingerprint **`G2YH-NBDP-RN54`**. Check that fingerprint, not the long string —
forty-three characters of base64 cannot be compared by eye, twelve grouped
characters can, and the app asks you to confirm you checked it before it will
add an anchor.

Trusting this key roots your trust graph in it. Nothing obliges you to, and the
app ships with no anchors at all — a fresh install trusts nobody, including
whoever wrote it.

**What being an anchor does and does not mean.** It is not an admin account.
There is no login, no console, and no privileged code path anywhere in this
repository — `getAnchors()` returns `[]` on a fresh device and the Remove button
works on any anchor including yourself. An anchor's reach is exactly the number
of people who chose to paste its key, and it becomes meaningful only through
vouching people in person. A published key with no vouches confers nothing.

---

## What exists today

| Capability | Where |
|---|---|
| Ed25519 identity, generated and held on-device | [`src/lib/crypto/keys.ts`](src/lib/crypto/keys.ts) |
| Twelve-word BIP-39 recovery, no password anywhere | [`src/lib/crypto/keys.ts`](src/lib/crypto/keys.ts) |
| Optional PIN lock (PBKDF2 + AES-GCM), opt-in | [`src/lib/crypto/vault.ts`](src/lib/crypto/vault.ts) |
| Lock/unlock UI, session-only unlocked key | [`src/components/identity/VaultPanel.tsx`](src/components/identity/VaultPanel.tsx) |
| Binary wire format signed as raw bytes | [`src/lib/codec.ts`](src/lib/codec.ts) |
| Two-scan offline vouching handshake | [`src/lib/vouch/protocol.ts`](src/lib/vouch/protocol.ts) |
| Sybil-resistant trust graph | [`src/lib/vouch/trust.ts`](src/lib/vouch/trust.ts) |
| IndexedDB schema + append-only CRDT oplog | [`src/lib/db/`](src/lib/db) |
| Hybrid logical clock for offline merges | [`src/lib/hlc.ts`](src/lib/hlc.ts) |
| Camera + paste + screenshot QR paths | [`src/lib/qr/`](src/lib/qr) |
| Client telemetry for debugging field failures | [`src/lib/telemetry.ts`](src/lib/telemetry.ts) |
| Per-op signatures + per-entity authorization | [`src/lib/sync/ops.ts`](src/lib/sync/ops.ts) |
| Static JSON bundles over any CDN | [`src/lib/sync/bundle.ts`](src/lib/sync/bundle.ts) |
| Order-independent CRDT merge | [`src/lib/sync/merge.ts`](src/lib/sync/merge.ts) |
| Cursor + ETag pull, file/relay push | [`src/lib/sync/transport.ts`](src/lib/sync/transport.ts) |
| Multi-frame animated QR, phone to phone | [`src/lib/sync/frames.ts`](src/lib/sync/frames.ts) |
| GitHub Actions as the compute layer | [`scripts/aggregate-bundles.mjs`](scripts/aggregate-bundles.mjs) |
| Two-signature settlement handshake | [`src/lib/ledger/entry.ts`](src/lib/ledger/entry.ts) |
| Mutual-credit balances + credit limits | [`src/lib/ledger/balance.ts`](src/lib/ledger/balance.ts) |
| Trust-gated marketplace | [`src/components/market/`](src/components/market) |
| Opinion clustering + bridge-finding | [`src/lib/deliberate/cluster.ts`](src/lib/deliberate/cluster.ts) |
| Vote queue with no reply button | [`src/components/deliberate/`](src/components/deliberate) |
| Daily opinion analysis on CI | [`scripts/analyse-deliberation.mts`](scripts/analyse-deliberation.mts) |
| Cross-group moderation policy | [`src/lib/moderate/policy.ts`](src/lib/moderate/policy.ts) |
| Signed flags and vouch revocation | [`src/lib/moderate/`](src/lib/moderate) |
| Relayable self-signed records | [`src/lib/crypto/attest.ts`](src/lib/crypto/attest.ts) |
| Anchor endorsement, rotation, retirement | [`src/lib/anchor/governance.ts`](src/lib/anchor/governance.ts) |

---

## Limits

Two things this build does not do. Both are decisions, not gaps, and both are shown to users on the
identity page rather than only living here.

### One language at a time, bridged by people

An early version tagged everything with a language and offered a picker while nothing translated and
nothing filtered on it. The picker promised a capability that did not exist — post in Hausa and
expect Hausa speakers to find it, and nothing whatsoever happened — so the tags and pickers were
removed rather than left as decoration.

They are back now, because there is finally something behind them. **A translation is a signed
human act**: someone who reads both languages writes it, signs it with their key, and can be paid in
time credits like anyone else doing an hour of work. It never replaces the original — it hangs
beside it, attributed, so you can see who rendered it and what standing they hold.

Two things this deliberately is not.

**It is not a language filter.** Here language tracks the very divides the app exists to cross, so
"show me only what I can read" would be ethnic filtering with a friendly label. Worse, deliberation
ranks statements by what bridges opinion *groups* — filtering by language would partition those
groups before the algorithm ran, and what surfaced would be consensus inside one bloc. There is no
call anywhere in `lib/lang/` that removes content because of the language it is in. The tag exists
to find work that needs doing, and the queue it feeds is the inverse of a filter: it shows what you
cannot read to the people who can.

**It is not machine translation.** A model small enough for a 2GB Android phone is not good enough
to be trusted with what a neighbour said, and a translation pass in CI would put a machine in the
middle of every sentence people exchange — in an app whose whole claim is that nothing sits between
them. It would also be one more thing to capture: whoever ran the pass would decide what everyone
else understood.

Name the cost plainly: **this only works where a bilingual neighbour shows up.** Nothing is rendered
until a person does it, so a commons with no bilingual members stays as divided as it was. That is a
real limit, and it is the honest one — the alternative was an oracle.

### No appeals process

Moderation withholds; it never deletes, and there is no route to contest a withholding. That follows
from having no server: an appeal needs an arbiter, an arbiter is an authority, and an authority is
the thing this architecture exists without.

What stands in for it is narrower and weaker, and worth being precise about:

- **Cross-group corroboration** — one bloc alone cannot withhold anything, so the common abuse of an
  appeals process is structurally unavailable in the first place
- **Every withheld item stays one tap from being read**, with the reason attached
- **Authors always see their own work**, and are told when others may not
- **The reader can switch hiding off entirely** — the device is sovereign

So a wrongly-withheld statement is recoverable by any individual reader, and never recoverable
*collectively*. There is no mechanism to make the community see it again. Resolution stays where the
design puts it: with the people who share the market.

---

## The vouching handshake

Joining requires meeting someone who already belongs. There is no invite link, because a link is a
bearer token and bearer tokens are exactly what a Sybil attacker wants.

```
  Adaeze (has standing)                     Bilkisu (new)
  ─────────────────────                     ─────────────
                                      1. builds a VouchRequest
                                         {subjectPub, nonce, name}
                                         signs it with her OWN key
                                         → shows QR
  2. scans it
     verifies Bilkisu's self-signature
     → proof-of-possession
     sees "Vouch for Bilkisu?"
  3. signs a TrustVoucher
     {issuer, subject, nonce, tier,
      issuedAt, expiresAt}
     → shows QR
                                      4. scans it back
                                         verifies Adaeze's signature
                                         checks subject == her own key
                                         checks nonce == the one she minted
                                         persists to IndexedDB
```

Two properties do the real work:

**Proof-of-possession.** Bilkisu signs her own request. Without it she could display a QR containing
someone else's public key and harvest vouches into an identity she does not control — or into one
belonging to a real person being impersonated.

**Nonce binding.** The voucher echoes a one-time number Bilkisu just minted. Without it a voucher is
a standing bearer token: anyone who photographs Adaeze's screen replays it indefinitely, and no
device can distinguish a fresh vouch from a three-month-old screenshot.

Both are covered by the signature, because the signature is taken over the exact byte prefix that
precedes it. There is no canonicalisation step, so there is no canonicalisation bug.

---

## Sybil resistance

Signatures prove authorship. They prove nothing about personhood — keys are free, so an attacker
mints five hundred and has them vouch each other.

The scoring in [`trust.ts`](src/lib/vouch/trust.ts) rests on one observation: an attacker can create
unlimited *nodes* but cannot create unlimited *edges from honest nodes into their fakes*. Those edges
are the scarce resource, so the system measures flow across that boundary and caps it.

1. **Layered propagation.** Trust flows strictly outward from anchors. Nodes are assigned a BFS
   distance and only edges from a strictly smaller distance count, so a cycle can never feed itself.
2. **Capacity constraint.** An issuer's outgoing trust is divided by `sqrt(outDegree / freeQuota)`.
   Vouching for everyone devalues every vouch you have ever given, including past ones.
3. **Top-K aggregation.** At most the five strongest incoming vouches count, combined by noisy-OR.
   The sixth is worth nothing.
4. **Tier ceiling.** Nobody attests above their own standing, and a Steward's vouch produces a
   Neighbour — only anchors mint Stewards.

### Mechanism 1 was learned the hard way

The first implementation used iterative fixed-point propagation with mechanisms 2–4 in place. It
looks rigorous and it does not work. Simulated — one compromised Steward vouching 60 fakes that then
cross-vouch — the clique converged to **0.961**, *above* the **0.765** of the account that created
it. Each round the fakes' inflated scores fed the next round's edges.

Layering removes the possibility structurally instead of damping it. Same simulation, after:

| | before | after |
|---|---|---|
| Honest member | 0.765 (Steward) | 0.680 (Steward) |
| Best Sybil | **0.961 (Steward)** | **0.296 (Neighbour)** |
| Clique cross-vouches | amplifying | worth exactly zero |

Both figures are asserted in `verify:protocol`, so the regression cannot come back quietly.

### Anchors

Anchors are the axioms — the only scores not derived from something else. With an empty anchor set
every score in the system is zero and nobody leaves Observer.

They are chosen **by the device owner**, never shipped by us. A hardcoded anchor list would be a
central authority in decentralised costume. A community body — a mosque, a parish, a market
association, a co-operative — publishes its public key somewhere verifiable in person, and each
person decides whose word roots their graph. Two people in one town may hold different anchor sets
and compute different, equally valid scores.

**This is the honest limit of the design:** compromise an anchor and you mint real Stewards. No
cryptography prevents that. It is contained by keeping anchor sets small, physically accountable and
revocable — governance, not maths.

---

## Sync

Write locally, sync globally. There is no server: bundles are static JSON files served by any CDN,
and the daily merge runs on GitHub Actions, which is free for public repositories.

```
  device ──┐                                    ┌── device
           ├─→ commons/inbox/*.json ─→ CI job ──┤
  device ──┘   (PR, relay, or file)   (merge +  └── device
                                       compact)
                                          │
                              public/commons/snapshot.json
                                      manifest.json
           device ⇄ device directly, no network, via animated QR
```

### Bundles are untrusted transport

Every op carries its own author signature. A bundle's signature attests only *"I relayed these
bytes"* — never *"these claims are true"*. A relay can republish anyone's ops and cannot forge one,
so any device may rebroadcast any bundle it received. Gossip is safe by construction, and a
compromised relay can censor but never fabricate.

The tempting alternative — sign the bundle, trust its contents — makes whoever can write a file on
the CDN an authority over everything inside it.

### Authorization is per-entity

| Entity | Who may write it |
|---|---|
| `identity`, `listing` | Only the record's owner |
| `voucher` | **Anyone** |

The asymmetry is deliberate and load-bearing. A voucher is self-authenticating: it carries the
issuer's signature over its own bytes, verified independently. Relaying other people's vouchers is
precisely how the trust graph propagates. Requiring `op.author == issuer` would mean a vouch could
only ever reach devices the issuer personally synced with — which defeats sync entirely.

Uniform-strict authorization breaks trust propagation. Uniform-loose lets anyone author anything.

### Merge converges regardless of delivery order

For each op: if the record we hold has an HLC ≥ the incoming op's, skip; otherwise apply. That one
comparison makes application commutative and idempotent, so bundles arriving duplicated,
interleaved, or years apart converge to the same state everywhere. Sorting first would work for one
pass and fail the moment a late bundle arrived out of order — the normal case on phones that sync
every few weeks.

Tombstones are ordinary ops, so a delete races an edit by HLC like any other write. The suite covers
the resurrection bug specifically: a delete arriving *before* the record it deletes must not be
undone by the late-arriving `put`.

### Denial of service is a real threat here

Unlike Task 1, bundles arrive from a public URL. Ed25519 verification costs ~1ms, so a 100,000-op
bundle is a 100-second frozen main thread on a low-end phone — a DoS delivered as a legitimate file.
Caps are enforced **before** `JSON.parse` and before any signature work: 2 MB, 2,000 ops, plus a
verification budget and a trust-policy hook so unanchored authors' listings are dropped without ever
being verified.

### Content addressing, and a censorship attack it closed

Bundle ids are a hash of the op set alone — deliberately excluding publisher and timestamp. Deriving
the id from the signed document (the obvious first move, and what this originally did) makes it
depend on the wall clock, so a relay republishing identical ops mints a fresh id every run and every
device re-downloads byte-identical content forever.

Fixing that surfaced a second issue. Devices record merged bundle ids and never re-fetch them, so an
attacker who published junk carrying a *real* bundle's id would make devices skip the genuine one
permanently — silent censorship without forging anything. `verifyBundle` now recomputes the content
address and rejects any mismatch before transport records it.

### Data cost

The whole argument for this architecture, measured by the suite:

| | |
|---|---|
| 50 listings, raw JSON | 35.3 KB |
| Same, gzipped by the CDN | **6.0 KB** (123 B per listing) |
| Nothing changed since last sync | **one 304, ~0 bytes** |
| 11 ops over animated QR | 8.6 KB → 2.9 KB, 19 frames, 3.2 s |

### Push has no server — that is the design

A static host serves files and accepts nothing. The three honest paths, all implemented:

1. **Export a file** and send it however you already talk — WhatsApp, email, a pull request.
2. **Hand it to another phone** over animated multi-frame QR, no network at all.
3. **POST to an optional relay** you configure yourself.

(1) and (2) need no infrastructure and no trust in anyone, which is why they are primary.

### The compute layer

`.github/workflows/aggregate.yml` runs daily and on every inbox push. It verifies every op, merges,
and **compacts** — keeping one op per `(entity, entityId)`, since all but the newest is redundant
under last-writer-wins. A commons with 10,000 lifetime edits across 800 records compacts to 800 ops,
so a new joiner fetches one small snapshot instead of the entire history.

The aggregator holds **no signing key**, deliberately. A CI secret signing on behalf of the commons
would be a central authority with a single point of compromise. It is exactly as untrusted as any
other relay, and clients re-verify everything.

Because it reimplements canonicalization in dependency-free Node (so it can be reread or rewritten
in Python), `npm run verify:aggregator` runs it as a subprocess against real signed ops and
re-verifies its output with the app's own verifier. A one-byte divergence would break sync for every
device in the network, and would otherwise surface weeks later as "sync mysteriously stopped".

---

## Running your own commons

There is no Lacinia network to join and no registry to appear in. A commons is a **directory of
static JSON files** at a URL, and a group is whoever has pasted that URL into their Sync sources.
Two commons never conflict; a device may follow several, and every op is re-verified on arrival
regardless of which one delivered it.

```bash
git clone https://github.com/balogvn/lacinia-collective && npm install
```

1. **Deploy the app.** Any static host works — GitHub Pages, Netlify, Vercel, a Raspberry Pi on a
   school LAN, a folder on a USB stick. `npm run build` emits a fully static export. Set
   `NEXT_PUBLIC_BASE_PATH` if it is served from a subdirectory.
2. **Choose your anchors.** Create an identity, publish its public key and fingerprint where your
   people can check them, and have them add it under *Anchors → Manage*. This is the only
   irreducibly social step. The app ships with **no** anchors — not even the one above — so a fresh
   install trusts nobody until someone chooses.
3. **Accept contributions.** Members export a bundle and send it however they already talk; you drop
   it into `public/commons/inbox/` and commit. `.github/workflows/aggregate.yml` verifies, merges
   and compacts it into a snapshot on push and daily. The CI holds no signing key, so hosting a
   commons grants no authority over it.
4. **Or host nothing at all.** Steps 1–3 are a convenience. Two phones swapping animated QR frames
   across a table are a complete commons with no host, no domain and no internet — which is the
   configuration the whole protocol is designed around.

A commons is not a jurisdiction. It has no borders, no admin and no shutdown switch, because there
is nothing running that could be shut down.

### Inviting people to it

Under *Sync → Sources* there is **Invite someone**, which produces one link:

```
https://balogvn.github.io/lacinia-collective/join/#v=1&c=../commons/&n=Ikorodu+market&a=<anchor key>
```

Send it, or hold the QR up to someone's camera — it is a plain https URL, so any phone's camera app
opens it with nothing installed.

Three decisions in that link are worth knowing about.

**Everything rides in the fragment.** Fragments are never sent to a server, so no host log, CDN or
`Referer` header ever records which commons somebody was invited to. Which commons you follow is
social-graph metadata, and on a query string it would be readable by every hop in between.

**The commons address is stored relative.** `c=../commons/` rather than the full URL: it saves ~50
characters, which is the difference between a QR that scans on a cheap camera and one that does
not, and it makes a printed code portable — the same sheet works whether people reach the app at
github.io, a LAN address, or a folder on a USB stick.

**The anchor is offered, never applied.** This is the part that matters. A link carrying only an
address produces a commons that syncs perfectly and reads as completely empty — every score zero,
every tier Observer — because standing is derived from anchors and a new device has none. So the
invite carries them. But the join screen will not install one: it shows the twelve-character
fingerprint, asks whether you checked it against the poster or the person, and leaves the button
disabled until you say you did — per anchor, never pre-ticked, with no "trust all". A source may be
added with one tap because it is untrusted transport and can only decide what to show you. An
anchor is an axiom of your trust graph, and no forwarded link gets to write one.

---

## Mutual aid and time credits

One hour is sixty credits, whoever works it. That equality is the reason this is a time bank and
not a marketplace — it refuses to price a lawyer's hour above a cleaner's. Goods are quoted at the
time they would take to replace, and a listing worth `0` is a gift that never touches the ledger.

### There is nothing to double-spend

A currency with no server and devices offline for weeks cannot prevent double-spending by
consensus. So the ledger is **mutual credit** (Sardex, LETS, classic timebanks), not a token.
Balances start at zero, and every entry moves the same amount in opposite directions — the sum of
all balances is always exactly zero. Credits are created at the moment of exchange and destroyed
symmetrically. There is no stock of credits sitting anywhere, which is why there is nothing to
spend twice. You cannot spend what you do not have; you go negative instead.

This does not defend against the double-spend problem. It dissolves it.

### The risk that remains, and how it is bounded

Not double-spending, but **walking away with debt**: take help from fifty neighbours, reach −3000,
disappear. Credit limits bound the exposure, and they are earned rather than granted:

| Tier | May go into debt by |
|---|---|
| Observer | 1h — a single hour of goodwill on arrival |
| Neighbour | 8h — a working day |
| Steward | 32h |
| Anchor | 80h |

The limit is checked by the counterparty's device before it signs. The suite runs the attack: an
Observer attempting to take twenty 60-minute offers in a row completes one and is refused nineteen
times.

**The honest limit of that bound**, stated because the UI must not imply otherwise: a device can
only compute a balance from entries it has actually seen, so someone can withhold recent debts from
a stranger they have never synced with. A computed balance is a *lower bound* on how indebted a
person really is. Mutual credit bounds this risk and makes it social; it does not eliminate it.
Every balance therefore carries a `confidence` — `own`, `observed`, `thin`, or `none` — and the
screen says which.

### An entry with one signature is not an entry

Settlement is a two-scan handshake. The **provider proposes** (they know what was done) and the
**payer confirms** (nobody may be charged without consenting). Both sign identical bytes.

```
  Adaeze (did the work)                 Bilkisu (received it)
  ─────────────────────                 ─────────────────────
  1. proposes {from, to, amount,
     listingRef, nonce}, signs
     → QR, 158 B, v10
                                  2. scans, checks her OWN balance
                                     against her credit limit, signs
                                     → QR, 76 B, v6
  3. scans, matches the nonce to
     a pending proposal → entry
```

The confirmation QR is **not self-describing** — it carries only the nonce and the payer's
signature, because the proposing device already holds the proposal. This is a deliberate reversal
of the Task 1 decision to keep vouchers self-describing: a voucher is a durable credential that
gets re-scanned and relayed, where "signature invalid" is a rejection nobody can act on. A
confirmation answers local state, so the device can say *"no offer on this phone matches that"*,
which is precise and actionable. Different artefact, different tradeoff.

### Sync, and why anyone may relay an entry

Ledger entries carry both parties' signatures, so they are self-authenticating — the same asymmetry
as vouchers in Task 2, and for a sharper reason. A balance is meaningless if third parties cannot
see the entries behind it, so restricting relay to the two participants would mean nobody could
ever assess a stranger's standing before extending them credit.

`verifySignedOp` therefore checks both signatures on every relayed entry. Without that, a relay
could publish invented exchanges and mint credits for itself.

Entries are immutable and content-addressed, so merge conflicts are structurally impossible: the
same exchange arriving from both parties and three relays is one row.

### Zero-sum audit

`auditZeroSum` runs after every merge and every refresh. A non-zero total means an entry was counted
once rather than twice — arithmetic drift that would silently inflate the money supply, which is
the one failure a currency cannot recover from. It is surfaced in the UI rather than swallowed.

---

## Augmented deliberation

Agree, disagree, or pass on standalone statements. The app then finds the opinion groups that
actually exist and surfaces the statements that earn agreement **across** them.

### There is no reply button, and that is architecture

Threaded discussion rewards the dunk: the highest-engagement move is quoting someone in order to
win against them, which is exactly the dynamic that hardens the divides this project exists to
bridge. Removing the affordance removes the behaviour. You may write a statement or vote on one —
there is nothing to reply *to*, so there is nothing to win.

The author's name is also hidden at the moment of judgement. Once a name is attached people vote on
the person, not the claim. The author is still recorded and signed; it is simply not shown on the
card.

The cost is real and worth stating: nuance that would live in a reply has to become its own
standalone statement, which people find harder to write. Harder to write, impossible to brigade.

### Bridging is not popularity

Ranking by total agreement is majority tyranny with a scatter plot attached — the largest bloc's
positions float to the top, the minority concludes the tool is not for them, and leaves.

```
consensus(s)    = min over groups of the smoothed agree rate   ← the bridging metric
divisiveness(s) = max − min across groups
```

`min` is the load-bearing choice. One dissenting group is enough to sink a statement, no matter how
popular it is overall. The suite proves this rather than asserting it: in a deliberately polarized
room, the **tribal statement with 71% overall agreement ranks last** on bridging, while a **bridge
statement with 57% agreement ranks second**. A naive popularity ranking puts that tribal statement
at #2; bridging puts it at #5. A pipeline that merely re-sorted by headcount would fail that test.

### The pipeline

1. Build a participant × statement matrix from votes (−1 / 0 / +1).
2. Impute missing entries with the statement mean, then centre.
3. Two principal components by power iteration (NIPALS) directly on the matrix — no S×S covariance,
   so it runs on a phone.
4. k-means in that 2D space, k chosen by silhouette.
5. Per-group agree rates → consensus.

It runs **on the device**, so deliberation works with the network off. The CI job runs the identical
module over the whole commons; because the algorithm is deterministic, a device holding the same
votes computes the same answer rather than trusting a server's verdict about what the community
thinks.

### Determinism is a correctness requirement

Two offline devices with the same votes must produce the same groups, or they will disagree about
what the community thinks while both being right. Three traps, each handled:

- **Eigenvector sign ambiguity.** `(u, s)` and `(−u, −s)` are the same component. Left alone, two
  devices produce mirror-image maps, put the same person on opposite sides, and every group id
  disagrees across the network. Fixed by forcing the largest-magnitude loading positive.
- **k-means initialisation.** Seeded PRNG derived from a hash of the sorted statement ids — never
  `Math.random`, which is also unavailable in workflow scripts.
- **Float accumulation order.** Every key sorted before iteration.

### Three guards against confident nonsense

Clustering will always return *something*. These stop it returning something meaningless:

- **Empty and tiny groups are rejected.** A group with no members contributes its Laplace prior of
  0.5, which then sets the consensus floor for every statement. This was a real bug: a room in
  total agreement scored 0.5 across the board because k-means had produced an empty second cluster.
- **The evidence gate.** Only groups that actually voted on a statement may set its floor. "We have
  no evidence" and "they are divided" are completely different findings and must not share a number.
- **k is bounded by the evidence.** Resolving *k* groups needs roughly 3*k* statements. Without this
  a 7-statement conversation cheerfully reported four factions with a high silhouette — well
  separated in the projection, and still an artefact of two noisy axes and twenty-one people.

Below five participants or five statements it reports `insufficient` and says what is missing,
rather than drawing groups from a handful of votes and asking people to see themselves in them.

---

## Moderation

A commons with no server, no admin and no delete still needs an answer for a statement that is
abusive rather than merely unpopular. Three constraints kill the obvious designs:

1. **Nothing can be deleted.** Data gossips through signed bundles; once published it exists on
   other devices forever. Any design promising removal is lying. So moderation decides what a device
   **shows**, not what exists.
2. **Unpopular ≠ abusive.** Task 4 exists to stop the largest bloc speaking for everyone. A system
   that hides whatever gets enough reports hands that power straight back, wearing a safety badge.
3. **The real attack is factional.** In a tool built to bridge ethno-religious divides, the failure
   mode is one bloc mass-flagging the other bloc's statements — indistinguishable from legitimate
   use if you only count flags.

### Cross-group corroboration

The same shape as bridging, pointed the other way:

```
bridging    = min over groups of agreement      → surfaces what unites
withholding = min over groups of flag pressure  → hides only what ALL groups reject
```

A statement is withheld only when **every** group flags it. Flags from one group alone do nothing —
that is a disagreement, and disagreement already has a button.

Measured in the browser on real synced data, from a seeded 21-person conversation:

| Statement | Flags | Outcome |
|---|---|---|
| "The lock-up owners decide everything among themselves" | **14** — all of bloc A | **Visible** |
| "The traders from the north end are thieves…" | **10** — 6 of A, 4 of B | **Withheld** |

More flags survives. Fewer flags, corroborated across the divide, does not.

### The reason taxonomy does real work

There is deliberately no "I disagree" reason. **Harm** reasons (abuse, danger, deception) can lead
to withholding; **noise** reasons (spam, off-topic) can only ever downrank. Unanimous spam flags
from both groups still cannot hide anything. Collapsing the two into one "report" button is exactly
how a moderation queue becomes a voting booth.

`DANGER` clears a lower threshold than `ABUSE` — the cost of showing incitement for another day is
asymmetric. That exception is a named constant and stated in the UI, not buried.

### Fail open, and due process

Where evidence is insufficient, **show**. In a system whose purpose is bridging divides, wrongly
hiding costs more than wrongly showing.

- Every withheld item is listed openly with its reason and is **one tap from being read**.
- **Authors always see their own work**, whatever anyone has flagged — being withheld without being
  able to read what was withheld is disappearance, not moderation. This is checked *before* the
  self-flag rule, because a guarantee must beat a preference.
- Your own flag mutes an item for you alone, needing no corroboration — it censors nobody but you.
- The reader can turn hiding off entirely. The device is sovereign.

### One person, one objection

A flag's id is the content address of its signed bytes, and those bytes include the reason and the
timestamp — so re-flagging an item does not update your flag, it mints a second valid one. Every
count downstream then read one person as several: `flagCount` reported 60 where one person had
objected 60 times, and the weight sums behind corroboration counted them 60 times over.

`dedupeFlags` collapses to one objection per person per target, keeping their most recent, with a
deterministic tiebreak so two devices holding the same pair agree on which survives. It runs before
anything counts. Deduplicating on read rather than on write is deliberate: duplicates also arrive
over sync from devices whose behaviour we do not control, and every one of them carries a valid
signature.

Worth stating what this was and was not. The arithmetic looked alarming — `flagWeight` dilutes by
`sqrt(outgoing/quota)`, so N duplicates contribute `W · sqrt(N · quota)`, a linear count against a
square-root penalty, and on paper a fresh Observer key reached an Anchor's weight at 50 duplicates.
It did not translate into censorship power, because both decision paths already gate on *distinct
people*: cross-group corroboration needs every group to object, and the ungrouped fallback counts
distinct authors. Two hundred duplicates from one key still withheld nothing. The damage was a
displayed number that lied and weight sums that were wrong, not a way to bury a statement.

### Sybil resistance

Flag weight scales with trust tier (an Observer's flag is worth 0.15 of a Steward's), and flagging
everything dilutes every flag you have given — the same capacity constraint as vouching. Sixty
freshly-minted keys cannot hide anything.

### Revocation

Content moderation cannot answer "this person turned out to be a bad actor". **Only the issuer may
revoke their own vouch** — if anyone could revoke anyone's, the trust graph would be erasable by one
bad actor, an attack cheaper than forging trust and more damaging, because it strips standing from
people who earned it.

Revocations are self-signed and therefore relayable, which is not optional: a revocation has to
outrun the trust it cancels, or a compromised key stays trusted on every device the issuer never
synced with. There is no un-revoke — re-vouching is a fresh vouch, leaving an honest record of both
decisions.

### What this deliberately does not have

No appeals process (there is no server to arbitrate), no automated classification (it would be
wrong on-device), and no deletion. The honest position is that this system
bounds and slows abuse; it does not resolve it. Resolution stays where it belongs — with the people
who share the market.

---

## Engineering decisions worth knowing

**Binary wire format, not JSON.** `JSON.stringify` guarantees no key ordering across engines, so
signatures verify on one device and fail on another. Fixed-width big-endian fields make the bytes
themselves canonical.

**@noble/ed25519, not WebCrypto.** WebCrypto's Ed25519 arrived in Chrome 137 / Safari 17 / Firefox
129 and is absent from the old Android WebViews this targets. 4KB of portable JS beats a native
implementation present only on the devices we worry least about.

**No webfonts.** Offline-first forbids a runtime fetch; a metered connection forbids 100KB of
self-hosted Didone. The display face is a system stack (Didot / Bodoni 72 where present, serif
otherwise) costing zero bytes.

**Hand-written service worker.** Workbox would add ~40KB to solve problems this app does not have.
Sixty lines instead.

**Tombstones, never deletes.** A real delete on device A is indistinguishable from "never seen it"
on device B, so deleted rows resurrect on the next merge.

**Hybrid logical clocks.** A phone with a dead RTC boots to 1970; another has its clock set forward
to unlock a trial app. Under wall-clock LWW that device wins every future merge permanently.

**QR sizing is a real constraint.** A voucher is 153 bytes → 209 base64url chars → QR v10 at ECC-M.
There is a route to v8 — omit `subjectPub` and `nonce`, which the receiver already holds, and let it
reconstruct the signed prefix. We deliberately don't: it makes the payload non-self-describing, so a
voucher scanned on the wrong phone fails with "signature invalid" instead of "this was issued to
someone else". A rejection nobody can act on is worse than a second scan attempt.

---

## Storing the secret key

The secret key sits in IndexedDB. By default it is **not encrypted at rest**, and the app says so.

A mandatory PIN is exactly the pattern the project's own rules reject, and a forgotten PIN on a
shared family phone destroys an identity built over months of vouches. The PIN is therefore opt-in
and defends against one thing: a borrowed or stolen handset. It does not defend against malicious
script in the page, a compromised device, or a forensic image plus time.

The recovery phrase — not the PIN — is the real backup. It is retained locally so it can be viewed
again, which adds no exposure beyond what the stored key already carries, and removes the failure
mode where someone dismisses the phrase screen and later loses the handset.

---

## Verification

`npm run verify` — 504 checks across ten suites, each an attack or a field failure.

### `verify:protocol` — 95 checks

- codec round-trips at every length; UTF-8 truncation never splits a codepoint (Nigerian names make
  this the common case, not an edge case)
- deterministic key recovery through case and whitespace mangling
- impersonated request rejected by proof-of-possession
- tier tampering, subject mismatch, replay, self-vouch, expiry, future-dating
- **rows edited directly in IndexedDB are caught** — the signature alone is not enough, because
  columns like `tier` are denormalised out of `signedBytes`; every one is cross-checked against the
  bytes that were actually signed
- Sybil clique of 60 fakes with 3,540 mutual vouches stays at Neighbour
- scoring is order-independent, so two offline devices agree without communicating
- HLC ordering, merge, and extreme-skew absorption
- **the Nigeria-only `{state, lga}` records still verify and still match their own neighbours** —
  widening a place to `{country, region, area}` touched a field inside already-signed bytes, and a
  legacy listing that stopped matching upgraded neighbours would look like sync failing rather than
  like a migration bug

### `verify:sync` — 68 checks

- canonical JSON refuses floats, NaN, Infinity and present-but-undefined keys
- a listing signed by someone else, a relabelled `entityId`, a restamped HLC, an edited body and a
  non-canonical body are all rejected
- a third party **may** relay someone else's voucher — but a forged voucher inside a validly-signed
  relay op is caught
- ops survive an invalid publisher signature; one poisoned op does not discard the honest ones
- a bundle lying about its id is rejected (seen-set poisoning / silent censorship)
- size and op-count caps fire before parsing and before verification
- merge converges under forward, reverse and shuffled delivery; re-merging is a no-op; an
  out-of-order delete is not undone by a late `put`
- QR frames reassemble in any order, tolerate duplicates, and reset on a mixed transfer
- an unchanged manifest costs one 304 and no bundle fetch; network failure is reported, never thrown

### `verify:ledger` — 59 checks

- an entry with one signature, or a payer signature from the wrong key, is refused
- a confirmation cannot be replayed against a different offer
- amount, payer, provider and id rewritten directly in IndexedDB are all caught
- self-payment, zero, negative, fractional and absurd amounts are refused
- **all balances sum to exactly zero**, before and after duplication, in any order
- an Observer's twenty-offer walk-away spree completes once and is refused nineteen times
- a third party may relay an entry, but an invented exchange inside a valid relay op is caught

### `verify:deliberate` — 32 checks

- **the tribal statement (71% agreement) ranks below the bridge statement (57%)**
- groups recovered exactly match the planted blocs; no bloc is split
- most-divisive surfaces the tribal statements, not the internally-contested one
- identical and reordered input produce byte-identical results — no mirrored maps
- a room in full agreement reports one group, not an invented division
- 12 statements can support four groups; the same population on 6 cannot
- overwriting someone else's vote row is refused; changing your mind updates rather than
  double-counts; out-of-range vote values are refused

### `verify:moderation` — 54 checks

- **a unanimous 12-person bloc campaign does NOT hide a rival bloc's statement** — and the rule is
  symmetric in both directions
- a statement both groups independently flag IS withheld; DANGER at a lower threshold than ABUSE
- unanimous spam and off-topic flags downrank and never hide
- 60 freshly-minted keys cannot hide anything; flagging everything dilutes each flag
- authors always see their own work; every hidden item carries a reason and a way through
- a flag signature cannot be replayed as a revocation (domain separation)
- only the issuer may revoke; a forged or re-attributed revocation cannot strip standing
- relays may carry flags and revocations, but manufactured ones are caught

### `verify:anchors` — 29 checks

- an untrusted key endorsing anyone is ignored; two untrusted keys endorsing each other bootstrap
  nothing, so no cartel can form from outside the set
- a stolen anchor key signing a retirement surfaces it and changes nothing
- a rotation to an attacker's key is offered for confirmation, never followed
- endorsements from trusted anchors surface as candidates that are **not** in the anchor set
- accepting a retirement drops what that anchor rooted — measured, and exactly why it is manual
- relays may carry anchor actions, but manufactured ones are caught

### `verify:aggregator` — 16 checks

Runs the real CI aggregator as a subprocess and re-verifies its output with the app's verifier:
compaction keeps only the newest op per key, forged ops never reach the snapshot, and the two
canonicalizers agree byte-for-byte.

---

### `verify:invite` — 52 checks

An invite is the one artefact here designed to be forwarded by strangers into group chats, so every
check is a hostile link.

- `javascript:`, `data:`, `file:`, `blob:`, `ftp:` and `vbscript:` commons addresses are refused
- `//evil.example/commons/` looks relative and is not — it is resolved before it is judged, so it
  cannot borrow the inviter's origin, and it lands flagged as cross-origin
- an `http:` commons is refused from an `https:` page and allowed from an `http:` one, because the
  laptop-on-market-wifi case is real and the downgrade case is an attack
- bidi overrides, zero-width characters and control characters are stripped from the label, which
  is attacker-controlled text rendered next to a hostname
- 3,000 fuzzed links, none of which throws
- an invite carrying twelve anchors keeps four; garbage keys are dropped; duplicates collapse
- a link printed for GitHub Pages still resolves correctly when opened on a LAN address
- a real invite with one anchor is 135 characters — inside the 152 that scan reliably on a cheap
  camera, which is what storing the commons address relative buys

---

### `verify:firstrun` — 41 checks

The failure guarded against here is not a crash but the app telling a user something untrue about
their own device.

- a device holding 190 records is never described as empty, and a device with a source but nothing
  fetched is never told again that nothing has happened
- reading without a key is a resting state, not an error
- **an anchor that has vouched for nobody is called out rather than counted as success** — the
  deployed commons currently produces exactly this state, so a user can check a fingerprint,
  confirm it correctly, and still see 0.000
- revoked, expired and signature-failed vouches never make a root look live
- only the empty state may add anything to the device; every other prompt is a signpost
- the unrooted prompt names no key and no fingerprint, and points at a person rather than a link
- discovery resolves a fork's OWN commons on any host and base path, and an HTML page served with
  a 200 is refused as a manifest — which is what a static host returns for a path that is not there

---

### `verify:translation` — 58 checks

- re-attributing, editing, relabelling the language of, or retargeting a signed translation all fail
- a translation never claims the original's id and never records the translator as its author
- **two people rendering the same sentence differently both stand** — disagreement about meaning is
  information, not a conflict to resolve — while one translator's own revisions collapse to their
  newest, so one person cannot look like two agreeing with each other
- the work queue is a strict subset and never a replacement feed; reading more languages shrinks the
  queue, never the feed; an untagged item is never assumed foreign
- a withdrawn translation puts the work back in the queue
- **the gap list and the work list never overlap** — one is what you cannot read, the other is what
  you can read and have not rendered, and offering someone work in a language they do not read is
  the conflation those two functions exist to prevent
- your own rendering removes an item from your work list; somebody else's does not
- order is independent of arrival order, so two phones show the same thing without talking
- 53 languages, no duplicate codes, each with its own endonym — `ha`, `yo`, `ig` and `pcm` included,
  because a tag that does not match across devices is a translation nobody can find

---

## Project layout

```
src/
├── app/                     routes (landing, identity, aid, deliberate, guide, join)
├── components/
│   ├── identity/            workbench, vouch bench, anchors, recovery phrase
│   ├── market/              balance, listings, settlement bench, history
│   ├── deliberate/          vote queue, opinion map, bridging results
│   ├── moderate/            flag control, withheld panel, policy settings
│   ├── sync/                pull/publish panel, invite composer, animated-QR send + receive
│   ├── join/                what an invite link lands on
│   ├── lang/                translations shown beside originals
│   ├── onboard/             the first-run prompt
│   ├── qr/                  QR display and scanner
│   ├── landing/             live in-browser handshake demo
│   └── system/              service worker registration
├── hooks/                   useCommons, useMarketplace, useDeliberation
└── lib/
    ├── codec.ts             binary wire format
    ├── locality.ts          places, across the legacy and worldwide record shapes
    ├── invite.ts            invite links: build, parse, and refuse
    ├── firstRun.ts          what to tell a device that has nothing yet
    ├── lang/                languages, and translation as signed human work
    ├── hlc.ts               hybrid logical clock
    ├── telemetry.ts         client-side structured logging
    ├── crypto/              keypairs, signing, PIN vault
    ├── data/                ISO 3166 country list
    ├── db/                  schema, Dexie wrapper, repositories
    ├── vouch/               protocol + trust graph
    ├── ledger/              settlement protocol + mutual-credit balances
    ├── deliberate/          clustering, bridge-finding, deterministic ids
    ├── moderate/            flags, visibility policy, vouch revocation
    ├── sync/                canonical JSON, ops, bundles, merge, transport
    └── qr/                  render + scan
scripts/                     ten adversarial suites, CI aggregator, analyser, seeders
```

Layering is strict: `crypto` knows nothing of Dexie, `codec` knows nothing of crypto, `vouch`
composes both and knows nothing of React. Everything below `components/` runs headlessly in Node.

---

## Roadmap

**Task 1 — foundation.** *Complete.* Schema, identity, offline vouching, trust graph.

**Task 2 — sync.** *Complete.* Signed ops, static bundles, order-independent merge, cursor/ETag
pull, animated-QR P2P, and the GitHub Actions compute layer.

**Task 3 — mutual aid.** *Complete.* Marketplace with locality and category filtering,
trust-gated listings, the two-signature settlement handshake, mutual-credit balances and
tier-bound credit limits.

**Task 4 — augmented deliberation.** *Complete.* Statement voting with no reply button, on-device
opinion clustering, bridge-finding, and a daily analysis pass on the CI compute layer.

**Moderation.** *Complete.* Signed flags, cross-group corroboration, reader-sovereign policy, and
issuer-only vouch revocation.

**Anchor governance.** *Complete.* Anchors can sign endorsements, key rotations and retirements,
and those propagate like any other signed record — but **nothing applies automatically**. Anchors
are the axioms of the trust graph, so a network process that edited them would be using derived
trust to choose what trust derives from: circular, and capturable in both directions (a cartel
voting itself in, or a majority voting a rival out). Every action arrives as evidence for a decision
the device owner makes.

Auto-applying a retirement is the tempting exception, since removing an axiom shrinks trust rather
than inflating it. It is still refused: a stolen anchor key could otherwise sign one message and
collapse the standing of everyone that anchor ever vouched for.

Bootstrapping stays out of band and must — the first anchor cannot be endorsed by an anchor you
already trust. The app shows the human-checkable fingerprint and requires you to confirm you
checked it against the poster, the broadcast, or the person.

**First run.** *Complete.* Reading no longer requires a key — `runSync()` never did — so a cold
device adds the co-hosted commons in one tap, reads it as a guest, and creates an identity when it
wants to act rather than at the door. The prompt names one action per state and refuses to imply
standing that does not exist.

**Translation.** *Protocol complete, surfaced in deliberation.* Statements carry an optional
language tag, translations render beside the original with the language named, and anyone with a key
can add one. Attribution is deliberately withheld inside the vote queue — that surface hides a
statement's author so people judge the claim rather than the person, and a translator's name at the
same moment would put one back. It is signed, it syncs, and it is shown everywhere judgement is not
happening. The queue shows two counts that are easy to conflate and are opposites: what is **closed to you**
(written in a language you do not read, not yet rendered into one you do) and what **you could open
for someone** (you can read it and have not rendered it). Adding a language to what you read moves
an item from the first to the second. Reader languages are local, never published, and filter
nothing.

Payment is the ordinary two-signature settlement, not a second mechanism: the person who did the
work proposes and the other confirms, so a rendering is settled exactly like an hour of any other
help. The queue counts what you have rendered and links to the bench; nothing is owed until both
people sign. **Not yet surfaced:** translations on listings.

**Still outstanding:** nothing from the original roadmap. What remains are the two standing
limits described under [Limits](#limits): translation depends on a bilingual neighbour turning up,
and there is no appeals process.

---

## Licence

Not yet chosen. Intended to be copyleft — a commons that can be enclosed is not a commons.
