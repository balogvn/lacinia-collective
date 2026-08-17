/**
 * The relay: a postbox for a commons.
 *
 * WHAT THIS IS FOR
 * A static host serves files and accepts nothing, so publishing meant exporting
 * a JSON bundle and getting it committed into public/commons/inbox/ by hand.
 * That is not something most people can be asked to do, and it was the single
 * hardest wall in the product. This accepts an already-signed bundle over HTTP
 * and writes it where the aggregator will find it.
 *
 * WHAT IT IS NOT
 * It is not an authority and it is not a backend. It holds NO signing key, so
 * it cannot mint, edit or attribute a single operation. Every op inside a
 * bundle is signed by its author and re-verified by the CI aggregator and again
 * by every device that receives it. A hostile relay can therefore drop what you
 * send it, and that is the whole of its power — the same standing as any sync
 * source. Delete it and the app is unchanged: the file and QR paths need no
 * infrastructure and remain the ones that always work.
 *
 * WHY IT VALIDATES SO LITTLE
 * Deliberately. Signature checking belongs where the trust decisions are made,
 * which is on the devices. Everything here exists to protect the REPOSITORY —
 * its size, its history, and the Actions minutes a commit spends — not to
 * decide what is true. A relay that adjudicated content would be the authority
 * this design exists without.
 *
 * DEPLOY
 *   wrangler deploy
 *   wrangler secret put GITHUB_TOKEN     # fine-grained, ONE repo, contents:write only
 * Configure REPO ("owner/name"), BRANCH and INBOX below via wrangler vars.
 */

/** Bundles run 1-200KB in practice. Anything far past that is not a bundle. */
const MAX_BYTES = 512 * 1024

/** A bundle with more ops than this is a compaction problem, not a message. */
const MAX_OPS = 5000

/**
 * Stop the inbox growing without bound.
 *
 * The aggregator merges and compacts, so a healthy inbox is small and empties
 * as CI runs. A large one means either CI is broken or somebody is filling it,
 * and in both cases the right answer is to stop accepting rather than to keep
 * committing into a repository whose history can never be pruned.
 */
const MAX_INBOX_FILES = 200

const cors = (origin) => ({
  'access-control-allow-origin': origin || '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
})

const json = (status, body, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors(origin) },
  })

/**
 * base64 of a UTF-8 string, without exploding on large inputs.
 *
 * `btoa(String.fromCharCode(...bytes))` is the tempting one-liner and it throws
 * RangeError once the spread passes roughly a hundred thousand arguments —
 * which our own 512KB ceiling permits. Chunked, so the size cap is the only
 * thing that decides what is too big.
 */
function toBase64(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Hex sha256 of the exact bytes received. */
async function digest(text) {
  const bytes = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function github(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.REPO}/contents/${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'user-agent': 'lacinia-relay',
      ...(init.headers || {}),
    },
  })
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin')

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
    if (request.method !== 'POST') {
      return json(405, { error: 'Send a bundle with POST.' }, origin)
    }

    // Cheap rejection before reading the body at all.
    const declared = Number(request.headers.get('content-length') || 0)
    if (declared > MAX_BYTES) {
      return json(413, { error: 'That bundle is too large for this relay.' }, origin)
    }

    const text = await request.text()
    // Content-Length is a claim; the body is the fact.
    if (text.length > MAX_BYTES) {
      return json(413, { error: 'That bundle is too large for this relay.' }, origin)
    }

    let bundle
    try {
      bundle = JSON.parse(text)
    } catch {
      return json(400, { error: 'That is not a bundle.' }, origin)
    }
    if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.ops)) {
      return json(400, { error: 'That is not a bundle.' }, origin)
    }
    if (bundle.ops.length === 0) {
      return json(400, { error: 'That bundle is empty.' }, origin)
    }
    if (bundle.ops.length > MAX_OPS) {
      return json(413, { error: 'That bundle carries too many updates.' }, origin)
    }

    /*
      THE FILENAME IS OURS, NOT THEIRS.

      The obvious move is to use bundle.id, which is already a content address.
      It is also a value the client controls, and it is the ONLY thing that
      would decide a path in the repository — one unescaped `../` away from
      writing outside the inbox. Hashing the bytes we actually received removes
      the question entirely: the name cannot be influenced, byte-identical
      resubmissions collapse onto one file, and nothing the client says about
      itself is load-bearing.
    */
    const name = `${await digest(text)}.json`
    const path = `${env.INBOX || 'public/commons/inbox'}/${name}`

    // Already here: a replay, or a client retrying. Idempotent by construction.
    const existing = await github(env, `${path}?ref=${env.BRANCH || 'main'}`)
    if (existing.status === 200) {
      return json(200, { ok: true, duplicate: true, path }, origin)
    }

    const listing = await github(env, `${env.INBOX || 'public/commons/inbox'}?ref=${env.BRANCH || 'main'}`)
    if (listing.status === 200) {
      const files = await listing.json()
      if (Array.isArray(files) && files.length >= MAX_INBOX_FILES) {
        return json(503, {
          error: 'This commons has more waiting than it can take. Try again once it has caught up.',
        }, origin)
      }
    }

    const commit = await github(env, path, {
      method: 'PUT',
      body: JSON.stringify({
        message: `relay: bundle ${name.slice(0, 12)}`,
        content: toBase64(text),
        branch: env.BRANCH || 'main',
      }),
    })

    if (!commit.ok) {
      const detail = await commit.text()
      // Never echo the upstream body: it can carry token or repository detail.
      console.error('relay commit failed', commit.status, detail.slice(0, 200))
      return json(502, { error: 'The commons could not be written to just now.' }, origin)
    }

    return json(200, { ok: true, path, ops: bundle.ops.length }, origin)
  },
}
