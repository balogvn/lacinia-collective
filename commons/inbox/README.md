# Inbox

Drop signed sync bundles here as `*.json`. The aggregator (`npm run aggregate`,
and the daily GitHub Action) verifies every op, merges them into
`public/commons/snapshot.json`, regenerates `manifest.json`, and clears this
directory.

Submitting a bundle needs no account and no permission beyond opening a pull
request — every op carries its own author signature, so nothing here is trusted
on the basis of who submitted it.

## Getting a bundle

In the app: **Sync → Publish → Save bundle file**.

## What happens to invalid ops

They are logged and skipped. The job does not fail, because a public inbox will
receive malformed submissions as a matter of course and a permanently red build
teaches everyone to ignore the build.

## What the aggregator is not

It is not an authority. It holds no signing key, and clients re-verify every op
independently — the CI job is exactly as untrusted as any other relay. Its only
privilege is deciding what appears in *this* repository's snapshot; anyone who
disagrees can host their own and point their app at it.
