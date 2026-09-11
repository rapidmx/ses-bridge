# Code review notes — rapidmx/ses-bridge

This file exists so that Claude sessions working in this repo don't re-litigate settled
decisions or re-discover the same issues from scratch. It is local to this repo (not tied to
any one machine's global Claude memory), so it travels with the code.

**Maintenance rule:** when a standing decision changes, update the section below in place
(don't just append a contradiction lower down). When a new investigation/session produces a
decision, finding, or reverted approach worth remembering, add a dated entry under Session Log.
Keep entries terse — this is a reference, not a transcript.

## Standing decisions

- **Commit discipline.** Don't `git commit` unless explicitly asked for *that specific piece of
  work*. An autonomous-execution/"commit as you go" approval given for one approved plan (e.g. via
  plan mode) is scoped to that plan only — it does not carry forward to later, separate requests in
  the same session, even ones that look similar in kind (a follow-up review-and-fix pass, a
  refactor, a new feature), and even after a full review-and-fix cycle with passing tests. Default
  to leaving changes staged/unstaged and saying so; only commit automatically within the exact
  scope of a plan that was explicitly approved as autonomous. If unsure whether new work falls
  inside that scope, treat it as outside and ask.
- **Commit message style: a flat list of one-line, verb-led items — no summary/title line, no
  `-`/`*` bullet markers.** This isn't just a style preference — it's dictated by how `release`
  (`@rapidrest/cli`) actually builds `CHANGELOG.md`. `collectChangelogBullets`/
  `classifyChangelogLine` (that repo's `src/lib/release.ts`) parse `git log --pretty=format:%B` and
  treat **every non-blank line of a commit's full message as its own changelog bullet** — there is
  no subject/body distinction. A conventional "short imperative subject + blank line + prose body"
  commit therefore leaks one changelog bullet per body sentence, and a `-`/`*`-prefixed line breaks
  `classifyChangelogLine`'s verb detection (it reads the line's first whitespace-delimited word as
  the verb; a leading `-` defeats that lookup and the dash leaks into the changelog text as
  `"- - Added foo"`). Correct format:
  - No separate summary/title line — if a commit needs an overview, that overview is itself just
    one more flat line, not a heading distinct from the rest.
  - No bullet-marker prefix of any kind — write bare lines.
  - Lead each line with an imperative verb where it fits: `Add`/`Fix`/`Remove` (and `-ing` forms)
    are recognized and become `Added`/`Fixed`/`Removed` entries; `Configuring`/`Converting`/
    `Refactoring`/`Updating`/etc. become `Changed`. Anything else still works, defaulting to
    `Changed` verbatim — see `CHANGELOG_VERB_REWRITES` in that repo's `src/lib/release.ts` for the
    full map.
  - A blank line before a trailing git trailer (`Co-Authored-By:`, `Signed-off-by:`, etc.) is fine
    — trailers matching `CHANGELOG_NOISE_PATTERNS` are dropped from the changelog — but nothing
    else should follow the item list.
  This mirrors JP's standing convention across his other repos; copy this exact rule verbatim into
  each sibling repo's own NOTES.md rather than paraphrasing it, since the paraphrase is what caused
  this to be gotten wrong in the first place (see `@rapidrest/cli`'s own NOTES.md, 2026-09-07 entry,
  for the full incident writeup and the `CHANGELOG_NOISE_PATTERNS` fix that accompanied it).
- **Never bump a `package.json` `version` field, in this repo or any sibling `@rapidrest/*`/
  `@rapidmx/*` repo, and never publish/`npm publish` one.** JP has a formal release process for
  that. This applies even when a fix in a sibling repo is otherwise done and verified: land the
  source fix, leave the version field alone, and tell JP it's ready for him to version/publish
  himself. Once he publishes, bump *this* repo's dependency constraint (e.g.
  `"@rapidmx/restapi": "^X.Y.Z"`) to the version he actually published — that part is fine, since
  it's just declaring what this repo needs, not deciding a sibling repo's own release number.
- **This repo is a hybrid, not a pure app like `postfix-bridge`**: `src/transport/` is a published
  library entry point (`@rapidmx/ses-bridge`'s `SesMailTransport`, imported by `@rapidmx/server`
  and registered via `objectFactory.register(SesMailTransport, "MailTransport")` exactly like
  `PostfixSendmailTransport`), while `src/lambda/` + `infra/` is deployable AWS infrastructure (a
  Lambda invoked by an SES receipt rule, provisioned via CDK) — there is no long-running daemon and
  no Docker image/Helm chart the way `postfix-bridge` has. Don't reflexively add
  Dockerfile/docker-compose/helm back in for "parity" with the sibling repo; the deployment shape
  is genuinely different here. Outbound (`SesMailTransport`) lives here rather than in
  `@rapidmx/restapi` by JP's explicit choice, to keep all SES-specific code in one place, even
  though it would otherwise fit `restapi`'s own `MailTransport`-implementation precedent
  (`PostfixSendmailTransport`) just as well. Recipient rejection is "accept, then bounce" rather
  than a live SMTP-time reject, also by explicit choice — SES has no synchronous pre-accept hook
  the way Postfix's `tcp_table` does; a Lambda action only runs after SES has already accepted the
  message, so an unresolvable recipient is handled by calling `ses:SendBounce` for just that
  recipient rather than rejecting during the SMTP conversation.
- **DKIM: SES Easy DKIM, not RapidMX-generated keys.** `FsDkimKeyProvider`/`NullDkimKeyProvider`
  from `@rapidmx/restapi` are irrelevant to domains relayed through this bridge — SES generates and
  manages its own DKIM key material per verified identity (3 CNAME records to publish), so this
  repo never touches `Domain.dkimSelector`/`dkimPublicKey`. Wiring those 3 CNAMEs into the admin
  console's DNS-setup checklist UI is an explicitly separate, not-yet-scoped follow-up in
  `@rapidmx/restapi`/`@rapidmx/server` — not this repo's job.

## Session Log

### 2026-09-10 — Initial scaffold

Repo created fresh, scaffolded from `postfix-bridge`'s "universal pieces" (`.claude`, `.github`,
`.gitignore`, `.gitattributes`, `.npmignore`, `.yarnrc.yml`, `.vscode`, `validate.sh`,
`eslint.config.mjs`, `tsconfig*.json`, `vitest.config.ts`, `CONTRIBUTING.md`/`CONTRIBUTORS.md`,
`LICENSE`) at JP's explicit request, per the scoping conversation that preceded this (see the
session's own summary; not yet copied into this file's history since this repo didn't exist yet).

Deliberate departures from `postfix-bridge`'s template, all because this repo's actual deployment
shape differs (see the standing decision above):
- No `Dockerfile`/`docker-compose.yml`/`helm/` — nothing here runs as a long-lived container.
- `tsconfig.json` has `declaration: true` (postfix-bridge's is `false`) - this repo publishes
  `SesMailTransport` as a library, so `.d.ts` output is required, unlike a pure standalone app.
- `package.json` is scoped (`@rapidmx/ses-bridge`) with real `exports`/`types`, matching
  `@rapidmx/restapi`'s pattern, not `postfix-bridge`'s unscoped/no-exports app-only shape. Treats
  `@rapidmx/restapi`/`@rapidrest/core` as `peerDependencies` (supplied by whatever app installs
  this package) rather than direct `dependencies`, again mirroring `restapi`'s own precedent for
  its own peer-supplied host framework packages.
- `.github/workflows/ci.yml` keeps `postfix-bridge`'s build/lint/test/validate job shape verbatim,
  but swaps its Docker-image/Helm-chart publish jobs for a tag-gated `npm publish` job (matching
  `@rapidmx/restapi`'s own publish workflow) plus a `test-cdk-synth` job (sanity-checks
  `infra/`'s CDK app synthesizes, deliberately without real AWS credentials).
- `.vscode/launch.json` drops `postfix-bridge`'s "Docker: Attach to Node" entry (no container) and
  its already-stale `vscode-jest-tests` entry (that repo uses vitest, not jest, too — a template
  artifact there, not worth propagating) in favor of vitest-watch and `cdk synth` launch configs.

Not committed - same standing rule; JP reviews and commits when ready.
