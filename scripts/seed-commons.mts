/**
 * Seeds a demonstration commons into `commons/inbox/`, then leaves it for the
 * aggregator to merge and publish.
 *
 * This exists so the sync layer can be exercised against a REAL static host and
 * a real network fetch — a mocked `fetch` proves the code paths work, not that
 * the deployed shape does. Run it, run the aggregator, serve the app, and add
 * http://localhost:3000/commons/ as a source.
 *
 *   npx tsx scripts/seed-commons.mts
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createSignedOp, type SignedOp } from '../src/lib/sync/ops'
import { createBundle } from '../src/lib/sync/bundle'
import { generateEphemeralKeyPair, fingerprint } from '../src/lib/crypto/keys'
import { createVouchRequest, parseVouchRequest, issueVoucher } from '../src/lib/vouch/protocol'
import { createClock, now as hlcNow } from '../src/lib/hlc'
import { TrustTier, VoucherStatus, type TrustVoucher } from '../src/lib/db/schema'
import { configureTelemetry } from '../src/lib/telemetry'

configureTelemetry({ mirrorToConsole: false })

const clock = createClock('seed0001')
const tick = () => hlcNow(clock)

// A community body and two members, as the trust model expects.
const anchor = generateEphemeralKeyPair()
const steward = generateEphemeralKeyPair()
const neighbour = generateEphemeralKeyPair()

const people = [
  { key: anchor, name: 'Ikorodu Market Association', lga: 'Ikorodu' },
  { key: steward, name: 'Adaeze N.', lga: 'Ikorodu' },
  { key: neighbour, name: 'Bilkisu A.', lga: 'Ikorodu' },
]

const ops: SignedOp[] = []

for (const person of people) {
  const hlc = tick()
  const identity = {
    pubKey: person.key.pubKeyId,
    fingerprint: fingerprint(person.key.publicKey),
    displayName: person.name,
    isSelf: false,
    deviceId: '',
    locality: { country: 'NG', region: 'Lagos', area: person.lga },
    createdAt: 1_700_000_000_000,
    hlc,
  }
  ops.push(
    createSignedOp(person.key, {
      hlc,
      entity: 'identity',
      entityId: identity.pubKey,
      op: 'put',
      record: identity,
    }),
  )
}

/** Runs the genuine Task 1 handshake so the vouchers are really signed. */
function vouch(issuer: typeof anchor, subject: typeof steward, tier: TrustTier): TrustVoucher {
  const request = createVouchRequest(subject, 'Subject')
  const parsed = parseVouchRequest(request.encoded.qr)
  if (!parsed.ok) throw new Error('seed handshake failed')
  const { voucher } = issueVoucher(issuer, parsed.value, tier)
  return {
    ...voucher,
    status: VoucherStatus.Valid,
    receivedAt: Date.now(),
    direction: 'INBOUND',
    hlc: tick(),
  }
}

const vouchers = [
  vouch(anchor, steward, TrustTier.Steward),
  vouch(steward, neighbour, TrustTier.Neighbour),
]

for (const voucher of vouchers) {
  // Relayed by the anchor — demonstrating that a third party may carry a
  // voucher it did not issue (see the asymmetry in sync/ops.ts).
  ops.push(
    createSignedOp(anchor, {
      hlc: voucher.hlc,
      entity: 'voucher',
      entityId: voucher.id,
      op: 'put',
      record: voucher,
    }),
  )
}

const offers = [
  { title: 'Rice, 5kg — spare from the shop', category: 'FOOD', credits: 45, author: steward },
  { title: 'Tailoring, one hour', category: 'SKILL', credits: 60, author: neighbour },
  { title: 'School books, primary 4–6', category: 'EDUCATION', credits: 0, author: steward },
  { title: 'Keke ride to the clinic', category: 'TRANSPORT', credits: 25, author: neighbour },
]

offers.forEach((offer, i) => {
  const hlc = tick()
  ops.push(
    createSignedOp(offer.author, {
      hlc,
      entity: 'listing',
      entityId: `seed-listing-${i}`,
      op: 'put',
      record: {
        id: `seed-listing-${i}`,
        authorPub: offer.author.pubKeyId,
        kind: 'OFFER',
        category: offer.category,
        title: offer.title,
        description: 'Seeded demonstration listing.',
        timeCredits: offer.credits,
        quantity: 1,
        locality: { country: 'NG', region: 'Lagos', area: 'Ikorodu' },
        minTrustTier: TrustTier.Observer,
        status: 'OPEN',
        createdAt: 1_700_000_000_000,
        expiresAt: 1_900_000_000_000,
        hlc,
      },
    }),
  )
})

const bundle = createBundle(anchor, ops)
const inbox = join(process.cwd(), 'commons', 'inbox')
await mkdir(inbox, { recursive: true })
await writeFile(join(inbox, 'seed.json'), JSON.stringify(bundle, null, 2))

console.log(`Seeded ${ops.length} ops into commons/inbox/seed.json`)
console.log('')
console.log('  Anchor public key (paste into the app\'s Anchors panel):')
console.log(`    ${anchor.pubKeyId}`)
console.log(`    ${fingerprint(anchor.publicKey)}`)
console.log('')
console.log('  Next:  npm run aggregate   then add http://localhost:3000/commons/ as a source')
