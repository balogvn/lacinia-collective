/**
 * What a device should be told when it has nothing yet.
 *
 * THE FAILURE THIS FIXES
 * A cold arrival used to create an identity and land on a workbench reading
 * 0.000 / Observer / 0 vouches / "from anchor —", with no sources, no anchors
 * and no records, whose first offered action was a QR code captioned "ask a
 * neighbour to vouch for you". That is an instruction to a stranger to go and
 * find a member they do not have. Every screen behind it was empty, and nothing
 * anywhere said which of the several missing things to fix first.
 *
 * READING NEEDS NO KEY
 * Merging verifies each record against ITS OWN author's signature, not against
 * the reader — `runSync()` takes no keypair, and a device with an empty vault
 * can pull and hold a whole commons. So the order is: read first, sign up when
 * there is something you want to DO. Demanding a keypair to look at a
 * noticeboard was a toll gate on a road with no bridge behind it.
 *
 * WHAT THIS MODULE REFUSES TO DO
 * It never invents standing. The lowest state is not an error and the copy for
 * it does not apologise: a device that has met nobody genuinely has no
 * standing, and the honest move is to say what standing is FOR and where it
 * comes from, not to seed a number that flatters the user.
 */

import { VoucherStatus, type PubKeyId, type TrustVoucher } from './db/schema'

/** Where a device is on the way to a working commons. Ordered by progress. */
export enum FirstRun {
  /** Nothing to read and nowhere to read it from. */
  Empty = 'EMPTY',
  /** Records have arrived; no key yet. A legitimate resting state — reading works. */
  Reading = 'READING',
  /** Has a key, no anchor. Everything is visible and every score is zero. */
  Unrooted = 'UNROOTED',
  /** Has a key and an anchor, but that anchor has vouched for nobody here. */
  InertRoot = 'INERT_ROOT',
  /** Nothing to prompt. */
  Ready = 'READY',
}

export interface DeviceFacts {
  hasIdentity: boolean
  sourceCount: number
  anchorCount: number
  /** Records held from other people — listings, statements, identities, vouchers. */
  recordCount: number
  /** True when at least one trusted anchor has issued a voucher this device holds. */
  rootHasVouched: boolean
}

export function assessDevice(facts: DeviceFacts): FirstRun {
  if (facts.sourceCount === 0 && facts.recordCount === 0) return FirstRun.Empty
  if (!facts.hasIdentity) return FirstRun.Reading
  if (facts.anchorCount === 0) return FirstRun.Unrooted
  if (!facts.rootHasVouched) return FirstRun.InertRoot
  return FirstRun.Ready
}

export interface Prompt {
  /** Short label above the headline. */
  eyebrow: string
  headline: string
  /** Why this is the state, in the app's own voice. Never apologetic. */
  body: string
  /** The single action worth offering here, or null when there is nothing to add. */
  action: { label: string; href?: string; kind: 'add-commons' | 'link' } | null
  /** Secondary route, always optional. */
  secondary?: { label: string; href: string }
}

/**
 * The one thing worth saying in each state.
 *
 * Deliberately ONE action each. The old screen offered vouching, syncing,
 * anchors, publishing and a PIN with equal weight, which is the same as
 * offering no guidance at all — the user has to already understand the trust
 * model to know which one unblocks the others.
 */
export function promptFor(state: FirstRun): Prompt | null {
  switch (state) {
    case FirstRun.Empty:
      return {
        eyebrow: 'Nothing here yet',
        headline: 'This phone is not following any commons',
        body:
          'A commons is a noticeboard somebody hosts — offers of help, requests, and the things a ' +
          'community is deciding. Adding one only tells this phone where to look. Nothing you add ' +
          'can put words in your mouth: every record is checked against the signature of whoever ' +
          'wrote it, so a bad host can hide things from you but can never forge anything.',
        action: { label: 'Add the commons this app came with', kind: 'add-commons' },
        secondary: { label: 'What is this?', href: '/guide' },
      }

    case FirstRun.Reading:
      return {
        eyebrow: 'You are reading as a guest',
        headline: 'Make a stamp when you want to join in',
        body:
          'Reading needs nothing — the records on this phone were each signed by whoever wrote ' +
          'them, and checked here. Posting, voting, vouching and settling an exchange are signed ' +
          'by you, so those need a key of your own. It takes no email and no password.',
        action: { label: 'Make my stamp', href: '/identity', kind: 'link' },
        secondary: { label: 'What is this?', href: '/guide' },
      }

    case FirstRun.Unrooted:
      return {
        eyebrow: 'Every score reads zero',
        headline: 'Your phone has not chosen anyone to trust yet',
        body:
          'Standing is worked out from a starting point you choose — a market association, a ' +
          'parish, a co-operative, a union. This app ships with none, on purpose, including its ' +
          'own author, so until you pick one there is nothing for standing to be measured from. ' +
          'Get the twelve-character fingerprint from a person or a poster, not from a link.',
        action: { label: 'Choose a starting point', href: '/identity#anchors', kind: 'link' },
      }

    case FirstRun.InertRoot:
      return {
        eyebrow: 'Rooted, but nobody is vouched for',
        headline: 'Standing comes from vouches, not from the root alone',
        body:
          'You trust a starting point, and on this phone it has vouched for nobody — so every ' +
          'score is still zero, including yours. That is not a fault in your setup. Standing ' +
          'spreads outward from vouches signed in person, so the next step is meeting someone ' +
          'that starting point has already vouched for, and having them vouch for you.',
        action: { label: 'Show my code to someone', href: '/identity#how', kind: 'link' },
      }

    case FirstRun.Ready:
      return null
  }
}

/**
 * Has any trusted anchor actually vouched for someone here?
 *
 * This exists because the deployed commons has an anchor that vouches for
 * nobody. Trusting it is a correct action that produces no visible change, and
 * a first run that stayed silent about that would have the user checking a
 * fingerprint, confirming it, and watching the number stay at 0.000 with no
 * explanation — which reads as the app being broken rather than as the graph
 * being empty.
 */
export function rootHasVouched(
  anchors: readonly PubKeyId[],
  vouchers: readonly TrustVoucher[],
): boolean {
  if (anchors.length === 0) return false
  const trusted = new Set(anchors)
  return vouchers.some((v) => v.status === VoucherStatus.Valid && trusted.has(v.issuerPub))
}

/**
 * The commons served alongside this build, if there is one.
 *
 * Derived from where the page is, never compiled in: a fork deployed anywhere
 * resolves its OWN commons, and no author's URL is baked into the bundle. The
 * caller still has to fetch it and decide whether the answer is real.
 */
export function coHostedCommonsUrl(pageUrl: string, basePath = ''): string | null {
  try {
    const base = new URL(pageUrl)
    const root = `${base.origin}${basePath}/`
    return new URL('commons/', root).toString()
  } catch {
    return null
  }
}

/**
 * Does this look like a commons manifest, or like a 404 page with a 200 on it?
 *
 * Static hosts routinely answer a missing path with the app shell and status
 * 200, so `response.ok` proves nothing. A build with no commons beside it must
 * report that plainly rather than offer a source that will never yield a record.
 */
export function isCommonsManifest(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return typeof m.v === 'number' && Array.isArray(m.entries)
}
