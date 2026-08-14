/**
 * Voucher revocation.
 *
 * Content moderation cannot answer "this person turned out to be a bad actor".
 * Withholding their statements one by one is whack-a-mole; what has to change
 * is their standing, and standing comes from vouches. So the person who gave a
 * vouch must be able to take it back.
 *
 * ONLY THE ISSUER MAY REVOKE. That single rule is the whole security property.
 * If anyone could revoke anyone's vouch, the trust graph would be erasable by
 * one bad actor — a far cheaper attack than forging trust, and far more
 * damaging, because it removes standing from people who earned it.
 *
 * SELF-SIGNED, THEREFORE RELAYABLE, AND THAT IS NOT OPTIONAL. A revocation has
 * to outrun the trust it cancels. If it only reached devices the issuer
 * personally synced with, a compromised key would stay trusted everywhere
 * else — which is exactly the window an attacker needs.
 *
 * THERE IS NO UN-REVOKE. Re-vouching creates a fresh vouch, leaving an honest
 * record of both decisions rather than pretending the first never happened.
 */

import { attest, verifyAttestation } from '../crypto/attest'
import type { KeyPair } from '../crypto/keys'
import {
  RevocationReason,
  VoucherStatus,
  type PubKeyId,
  type TrustVoucher,
  type VoucherRevocation,
} from '../db/schema'
import { log } from '../telemetry'

export const REVOCATION_DOMAIN = 'lacinia/revocation/v1'

export class RevocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RevocationError'
  }
}

export function createRevocation(
  issuer: KeyPair,
  voucher: TrustVoucher,
  reason: RevocationReason,
  now = Date.now(),
): VoucherRevocation {
  if (voucher.issuerPub !== issuer.pubKeyId) {
    throw new RevocationError(
      'Only the person who gave a vouch may withdraw it. This vouch was issued by someone else.',
    )
  }

  const body = {
    voucherId: voucher.id,
    issuerPub: voucher.issuerPub,
    subjectPub: voucher.subjectPub,
    reason,
    revokedAt: now,
  }
  const attestation = attest(issuer, REVOCATION_DOMAIN, body)

  log.info('trust', 'vouch revoked', {
    voucher: voucher.id.slice(0, 12),
    reason,
  })

  return {
    ...body,
    id: attestation.id,
    signature: attestation.signature,
    signedBytes: attestation.signedBytes,
    hlc: '',
  }
}

/**
 * Verifies a revocation against the key it claims to come from.
 *
 * `issuerPub` is inside the signed document, so a revocation cannot be
 * re-attributed to a different issuer without breaking the signature.
 */
export function verifyRevocation(revocation: VoucherRevocation): boolean {
  return verifyAttestation(
    REVOCATION_DOMAIN,
    revocation as unknown as Record<string, unknown>,
    revocation.issuerPub,
  )
}

/**
 * Applies revocations to a voucher set.
 *
 * A revocation only bites when it genuinely comes from that voucher's issuer —
 * checked here as well as at the op layer, because a row reaching this function
 * may have come from the local database rather than a verified bundle.
 */
export function applyRevocations(
  vouchers: readonly TrustVoucher[],
  revocations: readonly VoucherRevocation[],
): TrustVoucher[] {
  const revoked = new Map<string, VoucherRevocation>()

  for (const revocation of revocations) {
    if (!verifyRevocation(revocation)) {
      log.warn('trust', 'discarded revocation that failed verification', {
        id: revocation.id?.slice(0, 12),
      })
      continue
    }
    revoked.set(revocation.voucherId, revocation)
  }

  let applied = 0
  const out = vouchers.map((voucher) => {
    const revocation = revoked.get(voucher.id)
    if (!revocation) return voucher

    // Defence in depth: the op authorizer already enforces this, but a
    // revocation that reached the local table by any other route must not be
    // able to cancel a vouch it has no authority over.
    if (revocation.issuerPub !== voucher.issuerPub) {
      log.error('trust', 'revocation issuer does not match voucher issuer — ignoring', {
        voucher: voucher.id.slice(0, 12),
      })
      return voucher
    }

    applied++
    return { ...voucher, status: VoucherStatus.Revoked }
  })

  if (applied > 0) log.info('trust', 'revocations applied', { applied })
  return out
}

/** Vouches this key has issued and could still withdraw. */
export function revocableVouchers(
  vouchers: readonly TrustVoucher[],
  issuerPub: PubKeyId,
): TrustVoucher[] {
  return vouchers.filter(
    (v) => v.issuerPub === issuerPub && v.status === VoucherStatus.Valid && !v.deleted,
  )
}
