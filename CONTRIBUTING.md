# Contributing

Open an issue for a bug or a concrete feature proposal. Discuss substantial
changes before implementing them. Keep pull requests focused and explain the
behavior a reviewer should check.

## Development

Use the Rust 1.95.0 gnullvm toolchain pinned by `rust-toolchain.toml` and
Windows with ConPTY. Native build requirements are in [README.md](README.md).
CI uses Rust's bundled `rust-lld` linker with the `rust-mingw` component;
LLVM-MinGW remains an alternative native toolchain.

The project uses one Cargo package, the Rust standard library and original
browser code with native APIs. Do not add external crates, npm packages,
copied implementations or third-party runtime libraries.

Run the applicable checks from the repository root:

```text
cargo build --locked --offline
cargo fmt --all -- --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo test --locked --offline
node --test tests/browser.mjs tests/reader.mjs tests/upload.mjs
node --test tests/attribution.mjs
node scripts/check-attribution.mjs --history
```

Node and Chrome are development tools; they are not runtime requirements.
The CI also runs the owned Chrome acceptance suites. See
[DEVELOPMENT.md](docs/DEVELOPMENT.md) for fixture commands and coverage.
Use isolated directories and profiles. Never include credentials, CLI
authentication, terminal transcripts or personal uploads in a contribution.

## Pull requests

Write code, comments, documentation and commit messages in English. Preserve
the terminal's origin, session ownership and process boundaries. Keep modules
cohesive and around 500 lines or fewer; split by responsibility when necessary.

Submit changes through a pull request to `main`. Explain the problem,
resulting behavior, tests actually run and relevant limitations. The
maintainer reviews and merges changes after required checks pass.

The maintainer is the sole commit author. Commit messages and pull requests
must omit coauthor trailers, generated attribution and agent signatures.
The required `Commit attribution` check validates complete commit ancestry
and pull request metadata. GitHub's web committer is allowed for web merges.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
