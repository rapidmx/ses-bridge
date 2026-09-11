# Contributing

Thank you for your interest in contributing! This repository is part of the
[RapidMX](https://rapidmx.io) project which is composed of multiple repositories stored
on [GitHub](https://github.com/rapidmx). The same contribution process applies across
all repositories.

## Reporting bugs and requesting features

Please use this repository's Issues tab — file bugs and feature requests against whichever
RapidMX repository they actually concern.

### Bug Reports

A good bug report includes:

- **Steps to Reproduce** the bug (a minimal code sample is ideal).
- What you **Expected** to happen, and what happened instead (**Actual**)
- The **Reproduction Rate** (e.g. 3/3 with a minimum 3 tries) (**Repo Rate**)
- The **Severity** of the bug (e.g. _BLOCKER_, _HIGH_, _MEDIUM_, _LOW_)
- The **Project Info** containing the version of this package, whether the issue is in
  `SesMailTransport` (outbound) or the CDK-provisioned Lambda stack (inbound), the AWS region, and
  your Node.js version
- Include screenshots, crashdumps, logs, etc. when possible — for inbound issues, the relevant
  CloudWatch Logs excerpt for `ingestHandler` is usually the most useful thing to attach

Make sure to be as detailed as possible.

#### Example

```
Steps to Reproduce:
1. Send a message via SES to an address not provisioned on the RapidMX server
2. Wait for the SES receipt rule to invoke `ingestHandler`
3. Check the original sender's inbox

Repro Rate: 3/3

Expected:
A bounce notification for the unknown recipient

Actual:
No bounce is sent; CloudWatch Logs show `ingestHandler` erroring instead
// Insert full stack trace / CloudWatch log excerpt

Severity: HIGH

Project Info:
@rapidmx/ses-bridge: v0.1.0
AWS region: us-east-1
NodeJS: 24.0
```

### Feature Requests

For feature requests, please provide a description of the use case and how it relates to you as a developer or as an end-user.

Good feature requests start with the phrase "As a [developer|end-user] I would like the ability to..."

#### Example

```
As an operator I would like `SesMailTransport` to pick up the SES `configuration_set` from an
environment variable automatically, so I don't have to wire it through `server`'s own config
for every environment.
```

## Development setup

This project uses [Yarn](https://yarnpkg.com) (via Corepack) and requires Node.js `>=24.0.0`.

```sh
git clone <this-repo>
cd <this-repo>
corepack enable
yarn install
```

## Making changes

1. Create a branch off `main` for your change.
2. Keep changes focused to a single bug or feature.
3. Add or update tests for any behavior you change. Check `vitest.config.ts` for this project's
   coverage requirements.
4. Before opening a pull request, make sure everything passes:

    ```sh
    yarn install
    yarn build
    yarn test
    ```

5. Write commit messages that explain _why_, not just _what_ — the diff already shows what
   changed. Keep the first line short and imperative (e.g. "Fix path traversal in export output"),
   with further detail in the body if needed.

## Pull requests

- Describe what the change does and why, and link any related issue.
- Keep the PR scoped to one concern — it's fine to open several small PRs rather than one large one.
- CI must pass (lint, tests, build) before a PR can be merged.
- Be responsive to review feedback; if a change needs discussion, that's normal and expected.

## Attribution

Contributions are recognized in this repository's `CONTRIBUTORS.md`. Feel free to add yourself
in the same commit as your first contribution.

By submitting a contribution, you agree it will be licensed under this repository's `LICENSE`.

## Questions

If anything here is unclear, open an issue — that's useful feedback on this guide too.
