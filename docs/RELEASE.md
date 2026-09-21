# Release policy

Cybercore Mission Control is released as a private/alpha observation plane. A release is a
reviewed, checksummed binary bundle and source commit; it is not a promise of production support or
remote execution capability.

## Versioning

- The connector uses Semantic Versioning (`MAJOR.MINOR.PATCH`) from its Cargo package version.
- `CHANGELOG.md` keeps an `Unreleased` section and is promoted into a versioned heading for each
  release tag.
- The release tag must be `v<version>` and match `connector/Cargo.toml` exactly.
- `cybercore-agent --version` reports the package version, source commit, and compiled target.
- Breaking protocol or credential semantics require a major version and a documented migration.

## Supported artifacts

The release workflow builds native archives for:

- Linux `x86_64-unknown-linux-gnu`;
- macOS `x86_64-apple-darwin` and `aarch64-apple-darwin`; and
- Windows `x86_64-pc-windows-msvc`.

Each archive contains the connector binary, `LICENSE`, and the connector README. A SHA-256 file
and JSON manifest are published beside the archive. The workflow never publishes a crate or
deploys the Worker.

## Release checklist

1. Confirm the working tree is clean and the full CI matrix is green for the release commit.
2. Update `CHANGELOG.md`, verify the Cargo version, and review `docs/SECURITY.md`.
3. Create and push an annotated `v<version>` tag from the verified commit.
4. Inspect the draft release assets, checksums, manifest, and archive contents before publishing.
5. Verify `--version` provenance and a one-shot heartbeat against a non-production fixture.
6. Publish only after human review; keep the Worker deployment step separate.

## Upgrade and rollback

Stop the running connector, verify the replacement archive checksum, and replace the binary. If a
credential may have been exposed, revoke it in Mission Control before restarting. Roll back by
restoring the prior verified archive; no cloud-side command or local project mutation is required.
