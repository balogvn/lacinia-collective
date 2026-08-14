/**
 * Deterministic ids for deliberation records.
 *
 * Isolated in its own module because `sync/ops.ts` needs `voteIdFor` to
 * authorize vote ops, and importing the clustering engine there would drag
 * linear algebra into the sync hot path for the sake of one hash.
 */

import { contentId } from '../crypto/keys'
import type { PubKeyId } from '../db/schema'

/**
 * A vote's id is a function of (voter, statement) — NOT of its content.
 *
 * This is what makes changing your mind an UPDATE rather than a second vote.
 * With a content-addressed id, someone who voted agree offline, then disagree,
 * would merge into two contradictory rows and be counted twice — inflating one
 * side of every statement they touched. Deriving the id instead means the newer
 * vote wins by HLC and the older one is simply replaced.
 */
export function voteIdFor(voterPub: PubKeyId, statementId: string): string {
  return contentId(new TextEncoder().encode(`vote|${voterPub}|${statementId}`))
}

export function statementIdFor(
  authorPub: PubKeyId,
  conversationId: string,
  text: string,
  createdAt: number,
): string {
  return contentId(
    new TextEncoder().encode(`statement|${authorPub}|${conversationId}|${createdAt}|${text}`),
  )
}

export function conversationIdFor(authorPub: PubKeyId, title: string, createdAt: number): string {
  return contentId(new TextEncoder().encode(`conversation|${authorPub}|${createdAt}|${title}`))
}
