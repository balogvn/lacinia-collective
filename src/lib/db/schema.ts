/**
 * The domain model for The Lacinia Collective.
 *
 * Every record here is designed to survive being written on a phone that is
 * offline for a week and then merged with three other phones' versions of the
 * same record. That imposes three rules on every table:
 *
 *   1. Ids are content-addressed or key-derived — never auto-increment, because
 *      two offline devices would both mint id 7.
 *   2. Every mutable record carries an `hlc` for last-writer-wins resolution.
 *   3. Deletion is a tombstone (`deleted: true`), never a row removal. A real
 *      delete on device A looks identical to "never seen it" on device B, so
 *      the row would resurrect on the next merge.
 */

import type { HLC } from '../hlc'

/* ────────────────────────────── shared ────────────────────────────── */

/** base64url-encoded Ed25519 public key. The universal actor id. */
export type PubKeyId = string

/**
 * Nigeria-specific placement. Aid is intensely local — a bag of rice in Ikorodu
 * is useless to someone in Kano — so LGA is the unit that matters, not state.
 */
export interface Locality {
  state: string
  /** Local Government Area. */
  lga: string
  /** Optional ward/neighbourhood, free text. */
  ward?: string
}

/**
 * LANGUAGE: this build is English-only, deliberately.
 *
 * An earlier version tagged every listing, statement and identity with a
 * language and offered a picker (English, Nigerian Pidgin, Hausa, Yorùbá,
 * Igbo). Nothing translated and nothing filtered on it, so the picker promised
 * a capability that did not exist: someone posting a listing in Hausa would
 * reasonably expect Hausa speakers to find it, and nothing whatsoever would
 * happen. A control that misleads is worse than an absent one, so the tags and
 * the pickers are gone rather than left as decoration.
 *
 * This is a real limitation of the build, not a claim that language does not
 * matter — see the README. Records written by the earlier version still carry
 * a `language` field; it is ignored, and it still verifies, because signatures
 * cover the bytes as written.
 */

/* ─────────────────────────── UserIdentity ─────────────────────────── */

/**
 * Trust is a ladder, not a boolean.
 *
 * OBSERVER can read and post low-stakes offers. NEIGHBOUR is the working tier,
 * reached through peer vouches. STEWARD can vouch at full weight and unlock
 * pooled resources. ANCHOR is established out-of-band by a physical community
 * body (a mosque, a church, a market association, a co-op) and is the root of
 * the whole trust graph — the one place where offline social reality is
 * injected into the system.
 */
export enum TrustTier {
  Observer = 0,
  Neighbour = 1,
  Steward = 2,
  Anchor = 3,
}

export const TRUST_TIER_LABELS: Record<TrustTier, string> = {
  [TrustTier.Observer]: 'Observer',
  [TrustTier.Neighbour]: 'Neighbour',
  [TrustTier.Steward]: 'Steward',
  [TrustTier.Anchor]: 'Anchor',
}

export interface UserIdentity {
  /** PRIMARY KEY — base64url Ed25519 public key. */
  pubKey: PubKeyId
  /** Human-checkable short form, e.g. "K4T9-M2XW-8BQR". Derived, cached for display. */
  fingerprint: string
  displayName: string
  /** True for exactly one row: this device's owner. */
  isSelf: boolean
  /**
   * Stable per-installation id. Distinct from pubKey because one identity may
   * run on a phone and a shared community tablet, and CRDT tiebreaks must
   * distinguish the two writers.
   */
  deviceId: string
  locality?: Locality
  /**
   * Tier this device has been told about, out-of-band, for ANCHOR seeding only.
   * For everyone else the effective tier is COMPUTED from the vouch graph and
   * must never be read from here — a self-reported tier is worth nothing.
   */
  declaredTier?: TrustTier
  createdAt: number
  hlc: HLC
  deleted?: boolean
}

/** Never leaves the device; lives in its own table so it is never swept into a sync bundle. */
export interface VaultRecord {
  /** PRIMARY KEY — always the literal string 'self'. One identity per install. */
  id: 'self'
  pubKey: PubKeyId
  /** Present when the vault is unlocked/unprotected. base64url of the 32-byte secret. */
  plainSecret?: string
  /** Present when a PIN is set. Mutually exclusive with plainSecret. */
  sealed?: import('../crypto/vault').SealedSecret
  /**
   * The BIP-39 phrase, retained so the user can view it again later.
   *
   * This adds NO new exposure over what `plainSecret` already carries — anyone
   * who can read this row can already derive the key — and it removes the
   * failure mode where someone dismisses the phrase screen, loses the phone,
   * and loses an identity that took months of vouches to build. Cleared if the
   * vault is ever sealed under a PIN.
   */
  recoveryPhrase?: string
  /** False until the user confirms they wrote the phrase down. Gates the app. */
  phraseAcknowledged: boolean
  createdAt: number
}

/* ─────────────────────────── TrustVoucher ─────────────────────────── */

export enum VoucherStatus {
  Valid = 'VALID',
  Expired = 'EXPIRED',
  Revoked = 'REVOKED',
  /** Signature failed verification — retained for audit, never counted. */
  Invalid = 'INVALID',
}

/**
 * A signed statement: "I, issuer, know subject personally, at this tier."
 *
 * Content-addressed by the hash of its own signed bytes, so the same voucher
 * arriving from three different peers collapses to one row without a merge
 * step. `nonce` echoes the subject's request, binding this signature to one
 * specific in-person exchange — it cannot be replayed into a different one.
 */
export interface TrustVoucher {
  /** PRIMARY KEY — 32 hex chars of sha256(signed bytes). Deterministic across devices. */
  id: string
  issuerPub: PubKeyId
  subjectPub: PubKeyId
  /** Tier the issuer is attesting to. Capped by the issuer's own computed tier at scoring time. */
  tier: TrustTier
  /** Echoed from the subject's VouchRequest. Prevents replay into another exchange. */
  nonce: string
  issuedAt: number
  expiresAt: number
  /** base64url Ed25519 signature over the canonical byte prefix. */
  signature: string
  /** The exact bytes that were signed — kept so we can re-verify after a schema change. */
  signedBytes: string
  status: VoucherStatus
  /** When this device first stored it. Distinct from issuedAt (which the issuer controls). */
  receivedAt: number
  /** Direction, for cheap UI filtering: did we issue this or receive it? */
  direction: 'INBOUND' | 'OUTBOUND'
  hlc: HLC
  deleted?: boolean
}

/* ────────────────────────── ResourceListing ────────────────────────── */

export enum ResourceKind {
  Offer = 'OFFER',
  Request = 'REQUEST',
}

export enum ResourceCategory {
  Food = 'FOOD',
  Clothing = 'CLOTHING',
  Skill = 'SKILL',
  Transport = 'TRANSPORT',
  Shelter = 'SHELTER',
  Tools = 'TOOLS',
  Care = 'CARE',
  Medicine = 'MEDICINE',
  Education = 'EDUCATION',
  Other = 'OTHER',
}

export enum ListingStatus {
  Open = 'OPEN',
  Pledged = 'PLEDGED',
  Settled = 'SETTLED',
  Withdrawn = 'WITHDRAWN',
  Expired = 'EXPIRED',
}

/**
 * Time-banking unit: MINUTES. One hour of anyone's labour is 60 credits,
 * regardless of whose hour it is.
 *
 * That equality is a deliberate political choice and the reason this is a
 * time bank rather than a marketplace — it refuses to price a lawyer's hour
 * above a cleaner's. Goods are quoted in the time they'd take to replace.
 */
export type TimeCredits = number

export interface ResourceListing {
  /** PRIMARY KEY — content-addressed from author + creation stamp + title. */
  id: string
  authorPub: PubKeyId
  kind: ResourceKind
  category: ResourceCategory
  title: string
  description: string
  /** Cost/value in minutes. 0 means gift — outside the ledger entirely. */
  timeCredits: TimeCredits
  quantity: number
  unit?: string
  locality: Locality
  /**
   * Trust gate. A listing of donated medicine can require Steward, so a fresh
   * unvouched key cannot strip a community pool on day one. This is where
   * relational identity stops being decorative.
   */
  minTrustTier: TrustTier
  status: ListingStatus
  createdAt: number
  expiresAt: number
  /** Author's signature over the listing's canonical bytes — proves authorship after sync. */
  signature?: string
  hlc: HLC
  deleted?: boolean
}

/* ─────────────────────────── CRDT plumbing ─────────────────────────── */

/* ─────────────────────────── LedgerEntry ─────────────────────────── */

/**
 * A settled exchange: `from` paid `to` this many minutes.
 *
 * MUTUAL CREDIT, NOT A TOKEN. Balances start at zero and every entry moves the
 * same amount in opposite directions, so the sum of all balances is always
 * exactly zero. Credits are created at the moment of exchange and destroyed
 * symmetrically — there is no stock of credits sitting anywhere, which is why
 * there is nothing to double-spend. You cannot spend what you do not have; you
 * go negative instead, bounded by a trust-tier credit limit.
 *
 * Entries are IMMUTABLE and content-addressed by the bytes both parties signed.
 * There is no edit and no delete, so CRDT merge conflicts are structurally
 * impossible: the same entry arriving by six routes is one row.
 */
export interface LedgerEntry {
  /** PRIMARY KEY — content hash of the jointly-signed document. */
  id: string
  /** Payer. Their balance decreases. */
  fromPub: PubKeyId
  /** Provider. Their balance increases. */
  toPub: PubKeyId
  /** Positive integer minutes. One hour of anyone's labour is 60. */
  amount: TimeCredits
  /** First 16 hex chars of the listing id this settles, if any. */
  listingRef: string
  /** Binds the confirmation to one specific in-person exchange. */
  nonce: string
  agreedAt: number
  /** base64url signature by `toPub` — the proposer. */
  toSig: string
  /** base64url signature by `fromPub` — the payer, confirming. */
  fromSig: string
  /** The exact bytes both signatures cover. */
  signedBytes: string
  /** When this device first stored it. */
  recordedAt: number
  hlc: HLC
}

/**
 * How far negative each tier may go, in minutes.
 *
 * This is the ONLY thing standing between the commons and someone taking help
 * from fifty neighbours and vanishing. It is enforced by the counterparty's
 * device at signing time, not by any server — which also means it is only as
 * good as that device's view of the payer's history (see balance.ts).
 *
 * Observer gets one hour of goodwill on arrival; a working day at Neighbour.
 * The ceiling is earned socially, through vouches, rather than granted.
 */
export const CREDIT_LIMIT: Record<TrustTier, TimeCredits> = {
  [TrustTier.Observer]: 60,
  [TrustTier.Neighbour]: 480,
  [TrustTier.Steward]: 1920,
  [TrustTier.Anchor]: 4800,
}

/** Refuse absurd amounts outright — 1,000 hours is not a neighbourly favour. */
export const MAX_ENTRY_CREDITS: TimeCredits = 60_000

/* ──────────────────────── Augmented deliberation ──────────────────────── */

/**
 * A deliberation topic. Everything below it is a flat pool of statements.
 *
 * Note what is absent: there is no parent/child, no thread, no reply. That is
 * structural, not stylistic — see Statement below.
 */
export interface Conversation {
  /** PRIMARY KEY — content-addressed. */
  id: string
  authorPub: PubKeyId
  title: string
  /** The question people are responding to. */
  prompt: string
  locality?: Locality
  createdAt: number
  closesAt: number
  hlc: HLC
  deleted?: boolean
}

/**
 * A standalone claim someone can agree or disagree with.
 *
 * THERE IS NO REPLY FIELD, AND THAT IS THE POINT.
 *
 * Threaded discussion rewards the dunk: the highest-engagement move is quoting
 * someone in order to win against them, which is exactly the dynamic that
 * hardens the divides this project exists to bridge. Removing the affordance
 * removes the behaviour. You may write a statement, or vote on one. There is
 * nothing to reply TO, so there is nothing to win.
 *
 * The cost is real and worth stating: nuance that would live in a reply has to
 * be written as its own standalone statement, which people find harder. That is
 * the trade — harder to write, impossible to brigade.
 */
export interface Statement {
  /** PRIMARY KEY — content-addressed. */
  id: string
  conversationId: string
  authorPub: PubKeyId
  /** Kept short deliberately; a paragraph is an essay, not a claim to vote on. */
  text: string
  createdAt: number
  hlc: HLC
  deleted?: boolean
}

export const MAX_STATEMENT_CHARS = 280

export enum VoteValue {
  Agree = 1,
  Pass = 0,
  Disagree = -1,
}

/**
 * One person's position on one statement.
 *
 * The id is derived from (voter, statement) rather than content, so changing
 * your mind is a last-writer-wins UPDATE of the same row rather than a second
 * vote. Without that, someone flip-flopping offline would merge into two
 * contradictory votes and be counted twice.
 */
export interface Vote {
  /** PRIMARY KEY — contentId(authorPub | statementId). Deterministic. */
  id: string
  statementId: string
  conversationId: string
  authorPub: PubKeyId
  value: VoteValue
  createdAt: number
  hlc: HLC
  deleted?: boolean
}

/* ──────────────────────────── Moderation ──────────────────────────── */

/**
 * Why something was flagged.
 *
 * THERE IS DELIBERATELY NO "I DISAGREE" REASON, and the split below is the
 * heart of the moderation design.
 *
 * HARM reasons can lead to content being withheld. NOISE reasons can only ever
 * downrank it. Collapsing the two into a single "report" button is precisely
 * how a moderation queue turns into a voting booth: people report what they
 * dislike, the majority's dislike wins, and the tool that was built to protect
 * a minority's voice becomes the mechanism for removing it.
 *
 * Disagreement already has a button. It says Disagree.
 */
export enum FlagReason {
  /** Targets a person rather than a claim. */
  Abuse = 'ABUSE',
  /** Incites harm against someone. Lower threshold — see policy.ts. */
  Danger = 'DANGER',
  /** Impersonation, fraud, a scam listing. */
  Deception = 'DECEPTION',
  /** Automated or repetitive. Downranks only. */
  Spam = 'SPAM',
  /** Fine, but not about this. Downranks only. */
  OffTopic = 'OFF_TOPIC',
}

/** Reasons that can result in withholding. Everything else only downranks. */
export const HARM_REASONS: ReadonlySet<FlagReason> = new Set([
  FlagReason.Abuse,
  FlagReason.Danger,
  FlagReason.Deception,
])

export const FLAG_REASON_LABELS: Record<FlagReason, string> = {
  [FlagReason.Abuse]: 'Attacks a person',
  [FlagReason.Danger]: 'Could get someone hurt',
  [FlagReason.Deception]: 'Pretending or scamming',
  [FlagReason.Spam]: 'Spam or repetition',
  [FlagReason.OffTopic]: 'Not about this',
}

export type FlagTarget = 'statement' | 'listing' | 'identity'

/**
 * One person's signed objection to one item.
 *
 * Carries its own signature so ANYONE MAY RELAY it — a flag only your own
 * phone knows about protects nobody. Id is derived from (flagger, target) so
 * changing your mind is an update, never a second flag.
 */
export interface Flag {
  /** PRIMARY KEY — hash of the signed document. */
  id: string
  targetId: string
  targetEntity: FlagTarget
  /** Set when the target is a statement, so group corroboration can be computed. */
  conversationId?: string
  authorPub: PubKeyId
  reason: FlagReason
  createdAt: number
  signature: string
  signedBytes: string
  hlc: HLC
  /** Withdrawing a flag is a tombstone, like any other retraction. */
  deleted?: boolean
}

export enum RevocationReason {
  /** The key was lost or stolen. */
  Compromised = 'COMPROMISED',
  /** The person turned out not to be who they seemed. */
  Mistaken = 'MISTAKEN',
  /** They acted against the commons. */
  Harmful = 'HARMFUL',
  /** No longer know them well enough to stand behind it. */
  Lapsed = 'LAPSED',
}

export const REVOCATION_REASON_LABELS: Record<RevocationReason, string> = {
  [RevocationReason.Compromised]: 'Their key was lost or stolen',
  [RevocationReason.Mistaken]: 'I vouched by mistake',
  [RevocationReason.Harmful]: 'They acted against the commons',
  [RevocationReason.Lapsed]: 'I no longer know them well enough',
}

/**
 * Withdrawal of a vouch, by the person who gave it.
 *
 * Only the ISSUER may revoke, which is the whole security property: if anyone
 * could revoke anyone's vouch, the trust graph would be trivially erasable by
 * a single bad actor.
 *
 * Self-signed and therefore relayable, and that is not optional — a revocation
 * has to outrun the trust it cancels. A revocation that only reached devices
 * the issuer personally synced with would leave a compromised key trusted
 * everywhere else.
 *
 * There is no un-revoke. Re-vouching is a fresh vouch, which leaves an honest
 * record of both decisions rather than pretending the first never happened.
 */
export interface VoucherRevocation {
  /** PRIMARY KEY — hash of the signed document. */
  id: string
  voucherId: string
  issuerPub: PubKeyId
  subjectPub: PubKeyId
  reason: RevocationReason
  revokedAt: number
  signature: string
  signedBytes: string
  hlc: HLC
}

export type OpEntity =
  | 'identity'
  | 'voucher'
  | 'listing'
  | 'ledger'
  | 'conversation'
  | 'statement'
  | 'vote'
  | 'flag'
  | 'revocation'

/**
 * Append-only operation log. This — not the materialised tables — is what
 * actually syncs. Tables are a projection we can rebuild from the log, which
 * means a corrupted merge is recoverable rather than terminal.
 *
 * Structurally compatible with `SignedOp` in sync/ops.ts, plus local bookkeeping
 * fields that never cross the wire. The shape is duplicated here rather than
 * imported to keep `db/schema` free of any dependency on `sync/`, which imports
 * from it.
 */
export interface OpLogEntry {
  /** PRIMARY KEY — content hash of the signed document. */
  id: string
  hlc: HLC
  entity: OpEntity
  entityId: string
  op: 'put' | 'tombstone'
  /** Whoever signed this op. For vouchers this may be a relay, not the issuer. */
  author: PubKeyId
  /** Canonical JSON of the record — the exact bytes covered by `sig`. */
  body: string
  /** base64url Ed25519 signature over the canonical signed document. */
  sig: string

  /* ── local only, never serialised into a bundle ── */
  /** Has this op been folded into an outbound bundle yet? */
  synced: 0 | 1
  /** Did we author this locally, or receive it from a bundle? */
  origin: 'local' | 'remote'
  createdAt: number
}

/** Per-source pull cursor, persisted in `meta` under `sync.state.<url>`. */
export interface SyncSourceRecord {
  url: string
  label: string
  cursorHlc: string | null
  seenBundleIds: string[]
  manifestEtag: string | null
  lastPulledAt: number | null
  enabled: boolean
}

/** Simple key/value for cursors, settings and clock state. */
export interface MetaRecord {
  key: string
  value: unknown
}
