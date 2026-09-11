# RapidMX: SES Bridge

[![CI](https://github.com/rapidmx/ses-bridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rapidmx/ses-bridge/actions/workflows/ci.yml)

Bridges a [RapidMX server](https://github.com/rapidmx/server) to AWS SES for real inbound/outbound mail
transport - the SES equivalent of [`postfix-bridge`](https://github.com/rapidmx/postfix-bridge), but a
genuinely different shape: there's no long-running daemon here, because SES's own receiving pipeline is
event-driven, not a protocol this repo needs to speak on a socket.

This repo is two things in one:

- **A published library** (`@rapidmx/ses-bridge`) exporting `SesMailTransport`, a `MailTransport`
  implementation (see `@rapidmx/restapi`) that hands outbound mail to SES's `SendEmail` API directly -
  install it alongside `@rapidmx/server` and register it in place of `PostfixSendmailTransport`.
- **A CDK app** (`infra/`) that provisions everything inbound mail needs: an SES email identity (Easy
  DKIM), an S3 bucket to stage raw messages, a Lambda (`src/lambda/ingestHandler.ts`) that resolves
  recipients against the RapidMX server's `/internal/mta` contract and either delivers or bounces, and
  the SES receipt rule wiring it all together.

## Outbound: `SesMailTransport`

```ts
// server.mongo.ts / server.sql.ts, in place of PostfixSendmailTransport
import { SesMailTransport } from "@rapidmx/ses-bridge";
objectFactory.register(SesMailTransport, "MailTransport");
```

| Config key | Purpose |
| --- | --- |
| `mail:transport:ses:region` | AWS region SES sends from (default: the SDK's own region resolution - env var/shared config/instance metadata) |
| `mail:transport:ses:configuration_set` | Optional SES configuration set name for delivery/bounce/complaint event tracking |

Credentials are resolved via the standard AWS SDK credential provider chain (an IAM role in any real
deployment) - this class has no secret/key configuration of its own. The `From` address on every message
must be a verified SES identity, or SES rejects the send.

## Inbound: the CDK stack

```bash
git clone https://github.com/rapidmx/ses-bridge
cd ses-bridge
corepack enable
yarn install
SES_BRIDGE_DOMAIN_NAME=mail.example.com \
MTA_INGEST_BASE_URL=https://mail.example.com/internal/mta \
MTA_INGEST_SECRET=<same value as the server's mail__transport__ingest__secret> \
yarn deploy
```

| Environment variable | Purpose |
| --- | --- |
| `SES_BRIDGE_DOMAIN_NAME` | The mail domain this stack verifies, receives for, and sends as (default `example.com` - one domain per stack instance; deploy a second stack for a second domain) |
| `MTA_INGEST_BASE_URL` | Base URL of the RapidMX server's `/internal/mta` contract this bridge forwards to |
| `MTA_INGEST_SECRET` | Bearer secret authenticating this bridge's calls - must match that server's own `mail__transport__ingest__secret` exactly |
| `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` | Standard CDK environment targeting - see the [CDK docs](https://docs.aws.amazon.com/cdk/v2/guide/environments.html) |

**Known v1 simplification**: `MTA_INGEST_SECRET` is passed straight through as a plain Lambda environment
variable, visible in the Lambda console and this stack's own CloudFormation template. Fine for initial
evaluation; a real production deployment should switch this to a Secrets Manager reference the Lambda
resolves at runtime instead - not yet built here.

### After every deploy: three manual steps

CDK/CloudFormation can't do these declaratively, so `cdk deploy`'s own output prints exactly what to do:

1. **Publish the 3 DKIM CNAME records** (`DkimRecords` output) at your DNS provider - this both signs
   outbound mail (Easy DKIM) and verifies domain ownership; no separate verification TXT record is
   needed on top of these.
2. **Point the domain's MX record** at the value in the `MxRecordValue` output (priority 10) - this is
   what actually routes inbound mail to SES at all.
3. **Activate the receipt rule set** - CloudFormation has no resource for
   `ses:SetActiveReceiptRuleSet`. Run the exact command the `ActivateRuleSetCommand` output prints, e.g.:

    ```bash
    aws ses set-active-receipt-rule-set --rule-set-name <name from the output>
    ```

Until step 3 is done, mail addressed to the domain simply isn't received by this stack at all (SES's
default behavior for a domain with no active rule set matching it).

### How a message flows in

`SES receives → S3 action stores the raw MIME → Lambda action (this repo's ingestHandler) runs
synchronously → resolves each recipient against GET /internal/mta/resolve → bounces (ses:SendBounce) any
that don't resolve, delivers the rest via POST /internal/mta/deliver.`

This is deliberately **accept, then bounce** rather than a live SMTP-time reject - SES has no synchronous
pre-`DATA` hook the way Postfix's `tcp_table` does; a receipt rule's Lambda action only runs after SES has
already accepted the message. See `.claude/NOTES.md` for the full rationale.

### What this deliberately doesn't cover yet

- **Spam/virus scanning parity with the Postfix path** - `postfix-bridge`'s deployment scans inbound mail
  via rspamd/ClamAV before it ever reaches `server`; this bridge doesn't yet wire SES's own
  `scanEnabled`/verdict headers into anything. Tracked as a follow-up, not solved here.
- **Outbound bounce/complaint handling** - SES also emits bounce/complaint notifications for mail
  `SesMailTransport` sends (via SNS), which a mature integration would consume to mark bouncing
  addresses/list members. Not built here.
- **DNS-setup checklist UI** - the admin console's DNS-setup checklist (`Domain.dkimSelector`/
  `dkimPublicKey`) models the single-TXT-record RapidMX-generated-key flow, not Easy DKIM's 3-CNAME
  model this bridge uses. Publishing the CNAMEs is a manual step (above) until that UI is updated in
  `@rapidmx/restapi`/`@rapidmx/server` - a separate, not-yet-scoped change.

## Debugging

[Visual Studio Code](https://code.visualstudio.com/) is the recommended IDE to develop with. Use
`yarn test:watch` (or the "Debug vitest" launch config) for the library/handler unit tests, and
`yarn synth` (or the "cdk synth" launch config) to check the infra code without deploying anything.
