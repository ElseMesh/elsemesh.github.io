# Optional account and world roles

This document specifies the account boundary for ElseMesh. `server/accountd` implements opt-in Google ID-token verification, nonce-bound Ed25519 proof of possession, exact-origin CORS, short-lived in-memory sessions, and a private account-key mapping file. The browser includes an opt-in sign-in and account-key UI. `worldd` now consumes owner-signed `world.content.edit` grants at the proposal-inbox write path; this queues unsigned, reviewable proposals and does not publish or sign world content.

## Trust boundaries

- Worlds, nodes, and owners keep their existing cryptographic identities. Google is never a source of world ownership, node identity, manifest authority, or host grants.
- A world remains readable and playable as a guest when its visitor is signed out, offline, or unable to contact the account service. Accounts add optional per-world roles; they do not become a global login gate.
- Google proves control of a Google account to an optional account broker. It does not issue world roles. Only the key that owns a ThruHold can issue or revoke that world's role grants.
- Role grants target an account public key, not an email address or raw Google subject. A browser creates the key and proves possession. The broker privately maps the verified Google `sub` to that key so the same account can recover its account association on another device.
- Account and role endpoints are separate from `worldd`'s public manifest, asset, and lookup endpoints and from `directoryd`. CORS is never authorization. Account endpoints require explicit allowed origins and do not accept credentialed wildcard CORS.

## Sign-in and consent

The optional browser UI appears only when both `accountd` and `googleClientId` are set in `public/elsemesh-config.js`. The client loads Google Identity Services only after the user selects **Sign in with Google**. It obtains a fresh broker challenge, supplies its nonce to GIS, and sends the returned ID token only over HTTPS to the configured account broker. The broker verifies the token signature using Google's rotating public keys and checks issuer, audience, expiration, issued-at time, and the one-time nonce bound to the login attempt. Unknown signing keys trigger a bounded key refresh; token fields are not trusted before verification. The stable Google `sub` is the account key. Email, display name, and profile image are not account identifiers and are not stored unless a later feature asks for each item with separate consent. See Google's [GIS JavaScript API reference](https://developers.google.com/identity/gsi/web/reference/js-reference) for the nonce option and [ID-token verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token) for the server trust boundary.

The Google client ID and allowed web origins are explicit deployment configuration. Leave both values blank in `public/elsemesh-config.js` to hide the sign-in UI; world hosting, invites, guest viewing, and portal travel continue normally. Configure the Google OAuth web client for the exact game-site origin and configure `accountd` to allow that exact HTTPS origin. The account broker URL must itself use HTTPS. ID tokens are short-lived credentials: never place them in a URL, log them, or persist them in local storage. The client holds the credential in memory only long enough to complete the broker exchange. Account-broker session tokens are short-lived bearer tokens kept in memory and sent without cookies.

`accountd` is not part of the browser build and is not started by `worldd`. Run it only when account sign-in is wanted. Configure `ELSEMESH_GOOGLE_CLIENT_ID` and `ELSEMESH_ACCOUNT_ALLOWED_ORIGINS`, or pass `--google-client-id` and `--allowed-origins`. The origin list must contain exact canonical HTTPS origins, without paths or wildcards. The listener accepts only loopback addresses so the browser-facing endpoint must pass through a local HTTPS reverse proxy. The server verifies Google ID tokens with Google's maintained Go verifier, then separately checks the accepted Google issuer, issue time, and the challenge nonce. It ignores email and derives a private account lookup ID from Google `sub`; the on-disk `accounts.json` contains only that opaque ID and public-key fingerprints, with mode `0600`. Sign-in challenges expire after five minutes and are single-use. Bearer sessions expire after 15 minutes, exist only in process memory, and are invalidated by logout, key unlink, account deletion, or process restart. The routes are `GET /api/challenge`, `POST /api/session`, `GET /api/me`, `DELETE /api/me/key`, `POST /api/logout`, and `DELETE /api/account`. The browser key signs the UTF-8 message `elsemesh.account-proof/1\n<challengeId>\n<nonce>\n<origin>`; send the signature and Google ID token only over HTTPS.

## Account key and role grants

Each account device generates an Ed25519 signing key locally and sends only its public key to the broker after proving possession. The browser persists the non-extractable private `CryptoKey` in IndexedDB. The public key is exportable for the broker's proof-of-possession exchange. This follows the Ed25519 key-generation rules in the [Web Cryptography specification](https://www.w3.org/TR/WebCryptoAPI/#ed25519-operations). Browser profile access, device compromise, or clearing site data can expose or destroy locally held credentials. The private key never goes to Google, the broker, or a world node. The account panel can sign out, unlink the current browser key, or delete the account association; unlink and delete require confirmation. A later multi-device recovery flow may add a device after the user proves the same Google account and approves the new public key. Account recovery does not recover a world-owner key.

The first role-grant format accepts Ed25519 account keys. The public fingerprint is `sha256:` followed by lowercase hex SHA-256 of the raw 32-byte Ed25519 public key. Signed role payloads use canonical JSON and reject unknown fields. Initial supported scopes are `world.content.edit`, `world.portals.manage`, and `world.roles.manage`; a client or daemon must reject any other scope until a protocol version defines it.

The owner issues a versioned, owner-signed `tidewater.world-role/1` grant that binds:

- the world ID and owner PeerID;
- a random grant ID and monotonically increasing grant version;
- the account public-key fingerprint;
- a bounded set of role IDs/scopes;
- issue and expiry times.

Role grants cannot change the manifest, alter host grants, or grant ownership. `visitor` and read-only access require no role grant. `builder` and other future roles authorize only explicit actions defined by a versioned world capability; clients and nodes reject unknown scopes. The grant is not authority for concurrent simulation writes.

The owner publishes signed revocation state with a monotonically increasing serial and an expiry. A `worldd` gateway accepts an owner-signed state at `PUT /api/world/roles/revocations`, persists the complete signed document with mode `0600`, and rejects serial rollback. `GET /api/world/roles/revocations` returns the node's current document. Nodes can sync over libp2p from configured peers using `--role-state-from <peer-id>`; source documents are checked against the exact world and owner signatures, and old serials never replace newer local state. This may be pointed directly at the owner or at another already-synced world node. A persisted document remains a rollback floor after its 15-minute freshness window expires, but consumers must reject it for authorization until a fresh document arrives. Guest reads do not depend on role-state availability. A new owner key must explicitly transfer world ownership and reissue or revoke roles; a Google account cannot transfer a world.

## Delegated proposal intake

`POST /api/world/proposals` is the first delegated content action. It is accepted only by the node whose local key matches the world's owner PeerID. The request is an `elsemesh.world-proposal-submission/1` envelope containing the account's raw Ed25519 public key, the exact-world owner-signed role grant, and an `elsemesh.world-proposal/1` patch bound to a source hash and world ID. The non-extractable browser account key signs the canonical unsigned envelope with the domain prefix `elsemesh.world-proposal-submission/1\n`. `AccountClient.submitWorldProposal()` creates and sends that envelope after sign-in.

The node checks the account-key fingerprint, grant signature and lifetime, fresh owner revocation state, grant/key revocation, proposal world ID, source-hash syntax, allowlisted operation names, and the scopes required by every operation before storing anything. Object and world edits require `world.content.edit`; portal add, update, and remove operations require `world.portals.manage`. A proposal containing both operation types requires both scopes. Missing or expired revocation state fails closed for this write; guest reads and portal travel remain available. Identical submissions are idempotent. The owner node stores accepted envelopes under its private `--data` directory at `proposals/`, with mode `0700` for the inbox and `0600` for each file. The inbox is bounded to 4096 entries and 256 MiB, with a 16 MiB request limit.

Owners can create the signed role documents with `worldd`; the input JSON is the unsigned payload only. Both commands require the selected profile's `node.key` and exact signed `--manifest`, validate the world and time bounds, write a new `0600` file, and refuse to overwrite an existing output. A role grant input contains `protocol`, `worldId`, `ownerPeerId`, `grantId`, `version`, `accountKeyFingerprint`, `scopes`, `issuedAt`, and `expiresAt`. Revocation input contains `protocol`, `worldId`, `ownerPeerId`, `serial`, `issuedAt`, `expiresAt`, `grantIds`, and `accountKeyFingerprints`; its serial must exceed the persisted rollback floor.

```sh
worldd --world-profile island --manifest ./island.world.signed.json \
  --sign-role-grant ./grant.json --role-document-out ./grant.signed.json

worldd --world-profile island --manifest ./island.world.signed.json \
  --sign-role-revocations ./revocations.json --role-document-out ./revocations.signed.json

curl --fail --request PUT --header 'Content-Type: application/json' \
  --data-binary @revocations.signed.json https://world.example/api/world/roles/revocations
```

Publish a fresh revocation snapshot before accepting delegated proposals, including an empty snapshot when no grants have been revoked yet. Republish before the 15-minute freshness window expires. Grant `issuedAt` and `expiresAt` are Unix seconds; grants may live for at most 90 days.

Queueing is not acceptance: proposals remain unsigned and are not visible in the runtime manifest. Local owner commands list and export proposals; they require the matching signed manifest and the local identity key to be the manifest owner. They do not create an HTTP read endpoint, and reject inbox files whose content no longer matches the content ID or account signature.

```sh
# List IDs, account fingerprints, grant IDs, base-source hashes, and operation counts.
# Point --manifest at the signed world.json in the selected profile directory.
worldd --world-profile island --manifest /path/to/island/world.json --list-proposals

# Export only the unsigned patch; the destination must not already exist.
worldd --world-profile island --manifest /path/to/island/world.json \
  --export-proposal sha256:<proposal-id> --proposal-out ./proposal.json

# Apply it to the exact source snapshot named by its sourceHash, then review the diff.
node tools/apply-world-proposal.mjs --source ./island.world-source.json \
  --proposal ./proposal.json --out ./candidate.world-source.json
```

After rejecting a proposal or completing its publication, remove that exact queued submission:

```sh
worldd --world-profile island --manifest /path/to/island/world.json \
  --remove-proposal sha256:<proposal-id>
```

Removal requires the existing local owner key and matching signed manifest. It verifies the submission content ID, account signature, owner grant and world binding before deleting the private inbox file and syncing the directory. The command prints the removed submission metadata and preserves exported patches and world content. Missing, tampered, symlinked or wrong-world entries fail without removal. This is explicit inbox cleanup, not a publication or grant revocation: an editor with a still-valid grant can submit the same proposal again. Revoke the grant or account key when further submissions should be disallowed. Export any review record you want to retain before cleanup.

Export verifies the stored submission content ID and account signature, and checks that the owner-signed grant still names this world and account and contains the scopes required by its operations. A queued submission was authorized against fresh revocation state when it arrived; export does not make it accepted and does not override a later revocation. The owner must review the patch and candidate assets, apply it to the exact source snapshot named by its `sourceHash`, and inspect the resulting candidate before invoking publication. Publishing is an explicit local owner action; proposal intake never publishes automatically. Do not expose the private proposal inbox through the static web root.

### Owner publication

After reviewing the candidate source and its assets, publish it to the selected owner profile with:

```sh
node tools/publish-world-source.mjs \
  --worldd ./worldd \
  --data ~/.config/elsemesh/worlds/island \
  --base-source ./island.world-source.json \
  --source ./candidate.world-source.json \
  --assets ./worlds/island/assets
```

The command first asks `worldd` to verify the active signed manifest and confirm that the local node key is its owner. Runtime manifests record the SHA-256 of the exact source file used to produce them. The supplied `--base-source` must match that active signed hash, so a candidate based on an older source snapshot cannot be published. Existing manifests without a source hash require an explicit reviewed base file once; that publish records the baseline hash. The candidate must name the same world, and `worldd` independently hashes both source files (each must be a regular file no larger than 16 MiB) before signing. Publication preserves the current discoverability setting and authority epoch, constructs exactly the next manifest version, verifies and imports every referenced content-addressed asset, archives the previous signed manifest under `manifest-history/`, then atomically activates the new signed `world.json`. A failed validation or package import leaves the active manifest untouched. A publication lock prevents concurrent publishers; after a process crash, remove `.publish.lock` only after confirming no publisher is running. Restart the running `worldd` process after successful publication so it loads the new manifest. The owner profile and private proposal inbox must remain outside any static web root.

## Revocation, deletion, and recovery

- A user can unlink a Google account from an account key; the broker removes the mapping and active broker sessions.
- A world owner can revoke a role grant by grant ID or account-key fingerprint, publish fresh signed revocation state, and issue a replacement grant if appropriate.
- Revocation prevents new role-gated actions when the node receives the fresh signed state. It cannot retract data already downloaded or guarantee immediate revocation on an offline node; grants therefore expire and sensitive actions require fresh state.
- Account deletion removes the broker's Google-sub mapping and account metadata. It does not delete worlds, node identities, signed public history, or owner keys.
- World-owner recovery uses the existing offline owner-key backup and signed ownership-transfer process. Google recovery can restore an account-to-device association only; it cannot restore or replace a lost owner key.

## Implementation sequence

1. Implement and test the owner-signed role-grant and revocation document formats, with bounded fields, exact-world binding, key fingerprints, and safe-integer timestamps. The validation foundation, owner signing commands, and proposal-inbox consumer are present in `server/worldd`.
2. Implement the optional browser integration for the `accountd` broker. Server-side Google ID-token verification, nonce replay prevention, key proof-of-possession, private account-key mapping, short-lived sessions, exact-origin CORS, unlink, and deletion are implemented. The client UI and local key storage are also implemented; a production OAuth client ID and domain deployment remain operator configuration.
3. Persist owner-signed revocation state at each node and enforce increasing serials. The gateway storage API, opt-in libp2p synchronization, and fresh-state checks before proposal intake are implemented. Extend enforcement to future delegated actions as they are added. Keep asset reads and guest travel available without login.
4. Deploy no Google client ID or account broker by default. Each operator opts in and configures their own Google OAuth web client.

Until an operator configures an account broker and OAuth web client, Google sign-in and delegated proposal submission are unavailable. Current role enforcement covers proposal intake only; it does not authorize direct manifest/asset writes, portal administration, role management, simulation writes, or proposal acceptance/publication.
