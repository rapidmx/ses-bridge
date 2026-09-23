# Code review notes — rapidrest/mail-server

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
- **Never bump a `package.json` `version` field, in this repo or any sibling `@rapidrest/*` repo,
  and never publish/`npm publish` one.** JP has a formal release process for that (see e.g.
  `mail-server`'s own `"version"`/`"postversion"` npm-lifecycle scripts, which sync the Helm
  chart/README and push tags — a manual version edit bypasses all of that and produces conflicts).
  This applies even when a fix in a sibling repo is otherwise done and verified: land the source
  fix, leave the version field alone, and tell JP it's ready for him to version/publish himself.
  Once he publishes, bump *this* repo's dependency constraint (e.g. `"@rapidrest/auth": "^X.Y.Z"`)
  to the version he actually published — that part is fine, since it's just declaring what this
  repo needs, not deciding a sibling repo's own release number.

## Session Log

### 2026-09-11 — 100% coverage, real CONTRIBUTING.md

`ingestHandler.ts` had a handful of uncovered branches (`SesMailTransport.ts`/`MtaIngestClient.ts`
were already fully covered). Brought the whole package to 100% statements/branches/functions/lines
and pinned it via a new `thresholds` block in `vitest.config.ts` (there wasn't one before).

- Added coverage for `requireEnv()`'s own throw branch (a required env var missing at import time),
  `objectKeyFor()`'s `SES_OBJECT_KEY_PREFIX ?? ""` fallback, and `bounceRecipients()`'s
  `recipients[0].split("@")[1] ?? "localhost"` fallback (a malformed/no-domain recipient address) -
  all three needed a fresh `vi.resetModules()` + re-`import()` of `ingestHandler.js` per case, since
  its config is read eagerly at module load (see that file's own doc comment on why) - same pattern
  `postfix-bridge`'s `test/index.test.ts` and `electron-client`'s `test/main/index.test.ts` both use
  for the same reason. The existing test file's shared `beforeAll()`-imported `handler` is restored
  afterward so later tests in the same file keep using a fully-configured module.
- Fixed `CONTRIBUTING.md`'s bug-report/feature-request examples, which were the generic RapidMX
  template's `@rapidrest`/admin-console-flavored ones (copy-pasted from `server`/`restapi`, not this
  bridge) - replaced with an `ingestHandler`/bounce-relevant example and Project Info fields
  (package version, outbound vs. inbound, AWS region).
- Not committed - JP said "hold off on commit" for this whole cross-repo pass.

## 2026-09-15 — Ingest Lambda can run inside a VPC

The RapidMX server's own CloudFormation deployment (`server/deploy/aws`) keeps `/internal/mta` off the public internet:
the chart's `mail.ingestService` is an internal load balancer, and the public Gateway answers 404 for `/internal`. So
`ingestHandler` has to run inside that VPC.

- **Props:** `vpcId`, `subnetIds` (required together; `subnetIds` empty with a `vpcId` throws) and optional
  `availabilityZones`. `Vpc.fromVpcAttributes` with `privateSubnetIds`, deliberately not `Vpc.fromLookup`, so
  `cdk synth` still runs without AWS credentials (CI's synth job uses placeholder values). `vpcSubnets` is
  `vpc.privateSubnets`, i.e. the subnets given in the order given.
- **Security group:** created only in the VPC case, outbound-only, and output as `IngestHandlerSecurityGroupId` so it can
  be allowed on the server's ingest load balancer (the chart's `mail.ingestService.loadBalancerSourceRanges` covers the
  same thing by CIDR, which is what the server's template does by default with the VPC CIDR).
- **Egress caveat, documented not solved:** a Lambda in a VPC loses default internet access, and this handler reads each
  raw message from S3 and bounces through SES. Those subnets need a NAT gateway or VPC endpoints; the server's template
  creates a single public subnet, so a VPC-attached Lambda there needs one added.
- `SES_BRIDGE_VPC_ID` / `SES_BRIDGE_SUBNET_IDS` / `SES_BRIDGE_AVAILABILITY_ZONES` in `infra/bin/app.ts`, README and
  release notes. The README example now uses the `example.com` mail domain with an internal ingest URL.

Verified: `tsc --noEmit`, eslint, 18 tests; `cdk synth` without a VPC (unchanged) and with
`SES_BRIDGE_VPC_ID=vpc-… SES_BRIDGE_SUBNET_IDS=subnet-aaa,subnet-bbb` - the Lambda gets a `VpcConfig` with both subnets
and the new security group, and CDK attaches AWSLambdaVPCAccessExecutionRole. Not deployed to AWS.

## 2026-09-22 — Ported postfix-bridge's comma-envelope/timeout fixes, isolated per-record failures

An adversarial cross-repo review found `MtaIngestClient.ts` here still had the exact HIGH-severity bug
`postfix-bridge` fixed in `d7a1430`/`0b21d0d`: `deliver()` joined multiple `X-Envelope-To` recipients with
a bare `,`, which is ambiguous whenever a quoted local part legally contains a literal comma (RFC 5321) -
this file had simply never been touched since its original scaffold commit (`c6521e8`), so the fix never
made it over. It also had no per-call timeout on any `fetch()`.

- **Ported `encodeEnvelopeAddress()`** (percent-encoding via `encodeURIComponent`) verbatim from
  `postfix-bridge`, applied to `envelopeFrom` and every `envelopeTo` entry before they go into
  `X-Envelope-From`/`X-Envelope-To`. Same caveat as postfix-bridge's own fix: `restapi`'s
  `BaseMailIngestRoute.deliver()` still splits `X-Envelope-To` on a bare `,` and doesn't yet
  `decodeURIComponent` its segments - that companion fix belongs to that repo. This change only guarantees
  the *count* of recipients survives a comma-containing address intact.
- **Ported the `timeoutMs`/`DEFAULT_MTA_INGEST_TIMEOUT_MS` (10s) + `AbortSignal.timeout()` pattern** to all
  three `MtaIngestClient` calls. Lambda-specific nuance vs. postfix-bridge: a hung call here can't hang
  "forever" (the Lambda's own 30s function timeout in `ses-bridge-stack.ts` bounds it regardless), but
  without a client-side timeout it *silently consumes that entire remaining budget* on one call - worse
  than it sounds, since `ingestHandler` was previously resolving a record's recipients one at a time, so a
  single hung lookup starved every other recipient/record in the invocation from being processed at all.
- **Changed `ingestHandler`'s recipient resolution to run concurrently** (`Promise.all`, order preserved -
  see the new `resolveRecipients()` helper) instead of sequentially, so a slow recipient no longer
  serializes the rest of that record's own lookups behind it. Combined with the timeout above, this is the
  full fix for the "one recipient starves the batch" reliability issue.
- **Isolated per-record failures in `handler()`**: each record is now processed inside its own `try`/`catch`
  instead of one shared loop body whose exception rejects the whole invocation. Investigated whether this
  matters given the event source: a synchronous (`RequestResponse`) SES Lambda receipt action has no
  SQS-style per-item failure reporting, and on-failure destinations/DLQs only attach to *asynchronous*
  (`Event`) invocations, so neither of those safety nets is available or configured for this function. Before
  this fix, one record's failure (e.g. a transient `deliver()` error) rejecting the whole handler risked a
  retry of the *entire* invocation redelivering/re-bouncing every other record in the same event that had
  already succeeded - real duplicate-mail risk, not hypothetical. `console.error` (CloudWatch Logs) is the
  failure-visibility mechanism now used, since there's nothing else to hook into for this invocation type.
- **Bumped `@rapidmx/restapi` devDependency to `^0.19.0`** (was `^0.4.0`, far behind) **and added a `<1`
  upper bound to its peer range** (`>=0.4.0 <1`), matching every sibling plugin's convention. No source file
  under `src/` imports anything from `restapi` (only doc-comment references - this bridge only talks to it
  over the documented HTTP contract), so this was manifest-only; confirmed via `yarn install`/`yarn
  build`/`yarn test`. Note: `yarn install` prints a pre-existing `doesn't provide @rapidrest/service-core`
  peer warning (restapi's own peer dependency) - confirmed via `git stash` that this warning already existed
  before this bump too, not newly introduced by it; every other sibling plugin that depends on
  `restapi@^0.19.0` also declares `@rapidrest/service-core` (peer `2.x`, dev `^2.1.1`) to silence the
  equivalent warning in their own installs - left alone here since it doesn't fail the install/build/test and
  wasn't in scope for this pass, but worth adding if this warning ever needs to be silenced.

Verified: `yarn lint` (clean), `yarn build` (clean), `yarn test` - 26 tests passing (was 18), 100%
statements/branches/functions/lines maintained per `vitest.config.ts`'s pinned thresholds. Not deployed to
AWS; not verified against a live SES deployment.
