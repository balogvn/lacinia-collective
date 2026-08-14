/**
 * Balance computation and solvency.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO DOUBLE-SPEND CHECK IN THIS FILE
 *
 * Because there is nothing to double-spend. Under mutual credit, credits are
 * not a token anyone holds — they are created at the moment of exchange and
 * destroyed symmetrically, so the sum of every balance in the network is
 * always exactly zero. A balance is a *derived view* of signed bilateral
 * agreements, not an account someone can drain.
 *
 * This is the whole reason a currency is possible here at all. A token model
 * would need consensus (a chain) or an authority (a server) to stop the same
 * coin being spent twice, and we have neither and can afford neither.
 *
 * THE RISK THAT REMAINS is not double-spend but WALKING AWAY WITH DEBT: take
 * help from fifty neighbours, reach −3000, disappear. That is bounded by
 * CREDIT_LIMIT per trust tier, checked by the counterparty's device before it
 * signs.
 *
 * AND THE HONEST LIMIT OF THAT BOUND, stated plainly because the UI must not
 * imply otherwise: a device can only compute a balance from entries it has
 * actually seen. Someone can withhold their own recent debts from a stranger
 * they have never synced with, so a computed balance is a LOWER BOUND on how
 * indebted a person really is. Mutual credit bounds this risk and makes it
 * social; it does not eliminate it. Hence `BalanceView.confidence` — every
 * screen that shows a balance must show how much it is worth trusting.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { CREDIT_LIMIT, TrustTier, type LedgerEntry, type PubKeyId, type TimeCredits } from '../db/schema'
import { log } from '../telemetry'

export interface BalanceView {
  pubKey: PubKeyId
  /** Positive = the commons owes them. Negative = they owe the commons. */
  balance: TimeCredits
  earned: TimeCredits
  spent: TimeCredits
  entryCount: number
  /** How far negative this person may go, from their trust tier. */
  creditLimit: TimeCredits
  /** Headroom before hitting the limit. Never negative. */
  available: TimeCredits
  /** Most recent entry we have seen, or null. */
  lastActivityAt: number | null
  confidence: BalanceConfidence
}

export type BalanceConfidence = 'own' | 'observed' | 'thin' | 'none'

export const CONFIDENCE_NOTE: Record<BalanceConfidence, string> = {
  own: 'Your own balance, computed from every entry this phone holds.',
  observed: 'Based on entries this phone has seen. They may have newer ones elsewhere.',
  thin: 'Very few entries seen for this person — treat this as a rough guide only.',
  none: 'No history seen for this person on this phone.',
}

/** Below this many entries, a computed balance says almost nothing. */
const THIN_EVIDENCE_THRESHOLD = 3

/**
 * Computes balances for everyone appearing in the entry set.
 *
 * Deterministic and order-independent: entries are immutable and every one
 * moves the same amount in opposite directions, so summation commutes. Two
 * devices holding the same entries always agree.
 */
export function computeBalances(
  entries: readonly LedgerEntry[],
  tierOf: (pubKey: PubKeyId) => TrustTier,
  selfPub: PubKeyId | null = null,
): Map<PubKeyId, BalanceView> {
  const acc = new Map<
    PubKeyId,
    { earned: number; spent: number; count: number; last: number | null }
  >()

  const touch = (pubKey: PubKeyId) => {
    let row = acc.get(pubKey)
    if (!row) {
      row = { earned: 0, spent: 0, count: 0, last: null }
      acc.set(pubKey, row)
    }
    return row
  }

  // Deduplicate by id. Entries are content-addressed, so the same exchange
  // arriving from both parties plus three relays must count once.
  const seen = new Set<string>()

  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)

    const payer = touch(entry.fromPub)
    payer.spent += entry.amount
    payer.count++
    payer.last = Math.max(payer.last ?? 0, entry.agreedAt)

    const provider = touch(entry.toPub)
    provider.earned += entry.amount
    provider.count++
    provider.last = Math.max(provider.last ?? 0, entry.agreedAt)
  }

  const out = new Map<PubKeyId, BalanceView>()
  for (const [pubKey, row] of acc) {
    const balance = row.earned - row.spent
    const creditLimit = CREDIT_LIMIT[tierOf(pubKey)]
    out.set(pubKey, {
      pubKey,
      balance,
      earned: row.earned,
      spent: row.spent,
      entryCount: row.count,
      creditLimit,
      available: Math.max(0, balance + creditLimit),
      lastActivityAt: row.last,
      confidence:
        pubKey === selfPub
          ? 'own'
          : row.count === 0
            ? 'none'
            : row.count < THIN_EVIDENCE_THRESHOLD
              ? 'thin'
              : 'observed',
    })
  }

  return out
}

/** A person with no entries yet — balance zero, full credit line available. */
export function emptyBalance(
  pubKey: PubKeyId,
  tier: TrustTier,
  isSelf = false,
): BalanceView {
  const creditLimit = CREDIT_LIMIT[tier]
  return {
    pubKey,
    balance: 0,
    earned: 0,
    spent: 0,
    entryCount: 0,
    creditLimit,
    available: creditLimit,
    lastActivityAt: null,
    confidence: isSelf ? 'own' : 'none',
  }
}

export function lookupBalance(
  balances: Map<PubKeyId, BalanceView>,
  pubKey: PubKeyId,
  tier: TrustTier,
  isSelf = false,
): BalanceView {
  return balances.get(pubKey) ?? emptyBalance(pubKey, tier, isSelf)
}

/* ─────────────────────────── solvency ─────────────────────────── */

export interface SolvencyCheck {
  ok: boolean
  /** Balance the payer would hold after this settlement. */
  projected: TimeCredits
  limit: TimeCredits
  shortfall: TimeCredits
  reason: string
}

/**
 * May this payer take on this amount?
 *
 * Run on BOTH devices: the payer's own device before it signs (authoritative
 * for them, since they hold their complete history), and the provider's device
 * before it proposes (advisory, since its view may be incomplete). Two checks
 * because each side is protecting against a different mistake.
 */
export function checkSolvency(
  payer: BalanceView,
  amount: TimeCredits,
  /**
   * Whose device is asking. The same check runs on both sides of a settlement,
   * and a message reading "leaves them 90 min in debt" on your own phone is
   * confusing exactly when the number matters most.
   */
  subject: 'you' | 'them' = 'them',
): SolvencyCheck {
  const projected = payer.balance - amount
  const floor = -payer.creditLimit
  const ok = projected >= floor

  const isYou = subject === 'you'
  const Their = isYou ? 'your' : 'their'
  const they = isYou ? 'You' : 'They'

  if (ok) {
    return {
      ok,
      projected,
      limit: payer.creditLimit,
      shortfall: 0,
      reason:
        projected < 0
          ? `Leaves ${isYou ? 'you' : 'them'} ${formatCredits(Math.abs(projected))} in debt, within ${Their} ${formatCredits(payer.creditLimit)} limit.`
          : `Leaves ${isYou ? 'you' : 'them'} ${formatCredits(projected)} in credit.`,
    }
  }

  const shortfall = Math.abs(floor - projected)
  return {
    ok,
    projected,
    limit: payer.creditLimit,
    shortfall,
    reason: `This would go ${formatCredits(Math.abs(projected))} into debt, past ${Their} ${formatCredits(payer.creditLimit)} limit. ${they} would need to give ${formatCredits(shortfall)} of help first, or earn a stronger vouch.`,
  }
}

/* ─────────────────────────── formatting ─────────────────────────── */

/**
 * Minutes → human duration. Credits ARE minutes, but "480 min" means nothing at
 * a market stall and "8h" means a day's work.
 */
export function formatCredits(minutes: TimeCredits): string {
  const sign = minutes < 0 ? '−' : ''
  const abs = Math.abs(minutes)
  if (abs === 0) return '0'
  if (abs < 60) return `${sign}${abs}m`
  const hours = Math.floor(abs / 60)
  const mins = abs % 60
  return mins === 0 ? `${sign}${hours}h` : `${sign}${hours}h ${mins}m`
}

/**
 * Sanity check: mutual credit means every credit is someone else's debit, so
 * the sum of all balances must be exactly zero.
 *
 * Called after every merge. A non-zero total means an entry was counted once
 * rather than twice — arithmetic drift that would otherwise silently inflate
 * the money supply, which is the one failure a currency cannot recover from.
 */
export function auditZeroSum(balances: Map<PubKeyId, BalanceView>): {
  ok: boolean
  total: TimeCredits
} {
  let total = 0
  for (const view of balances.values()) total += view.balance

  if (total !== 0) {
    log.error('crdt', 'LEDGER IS NOT ZERO-SUM — credits have been created or destroyed', {
      total,
      accounts: balances.size,
    })
  }
  return { ok: total === 0, total }
}
