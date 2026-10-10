# Herdr web native adapter attribution

This adapter links `herdr-client` and `herdr-protocol` from
https://github.com/penso/herdr-gpui.git at commit
`e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf`, under Apache-2.0.
The exact revision appears in Cargo.toml and Cargo.lock. The dependency is not
vendored or modified, and the build does not use a neighboring checkout.

`LICENSE-APACHE` reproduces that project's Apache-2.0 license.
`PROTOCOL-NOTICE.md` reproduces its protocol attribution notice unchanged.
Its references to `src/` and `tests/` refer to the upstream protocol crate.

`interface.ts` adapts the public protocol declarations to TypeScript, retaining
field names and externally tagged JSON enums. It adds helper envelopes, limits,
base64 image entries, and exact large-integer handling. `tests/fixtures/endpoint-snapshot-v1.json`
is copied unchanged from the pinned protocol crate's synthetic fixtures.
The synthetic test suite uses the public protocol API and concepts demonstrated
by the upstream client tests, with helper process/JSONL assertions added here.

The protocol declarations and fixtures originate in Herdr 0.9.1, commit
`856b64b9bfd41b9d3d82e2375ed5b4bf941fda28`, Apache-2.0. Optional surface
codecs originate in Herdr commit `65e35a38`, as detailed in PROTOCOL-NOTICE.md.
No personal session data or live daemon output is included.

Other dependencies retain the licenses declared in their Cargo packages.
Cargo.lock records their versions and source checksums; distributing a binary
also requires distributing the notices/licenses required by those dependencies.
