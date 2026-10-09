# Security

Security fixes target the current `main` branch. The project is under active
development; older revisions do not have a separate support schedule.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/giovannijecha/webterminal/security/advisories/new).
Include the affected revision, Windows and browser versions, the boundary
crossed, and a minimal reproduction using synthetic data. Do not publish
security details, credentials or terminal content in an issue or pull request.

The maintainer will assess the report and coordinate a fix and disclosure.
There is no guaranteed response time.

## Boundaries

Webterminal is a local application bound to `127.0.0.1`. It serves its own
assets and controls processes with the invoking user's permissions. The
terminal uses exact Host/Origin checks, one controlling view per session,
and owned process handles. Uploaded files are temporary session data.

Relevant reports include cross-origin access, unauthorized terminal control,
access to another session's uploads, and unintended filesystem or process
effects. See [SPEC.md](SPEC.md) for the intended boundaries. Do not expose
the local server through a public proxy or tunnel.
