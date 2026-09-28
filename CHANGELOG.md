# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-09-28

### Added
- Added SesMailTransport, a MailTransport implementation relaying outbound mail via AWS SES's SendEmail API
- Added ingestHandler, a Lambda resolving SES-received recipients against /internal/mta/resolve and bouncing or delivering each via ses:SendBounce/POST /internal/mta/deliver
- Added a CDK stack provisioning the SES email identity (Easy DKIM), S3 staging bucket, ingestHandler Lambda, and receipt rule this bridge needs
- Added a per-call timeout (AbortSignal.timeout, 10s default via DEFAULT_MTA_INGEST_TIMEOUT_MS) to every MtaIngestClient upstream fetch, so a stalled restapi response fails fast instead of silently consuming the ingest Lambda's entire remaining execution budget
- Added a request timeout to the S3Client/SESClient instances ingestHandler constructs, closing the same silently-consumes-the-whole-Lambda-budget problem last round's MtaIngestClient timeout closed, for the S3 GetObject/SES SendBounce calls this time
- Added MTA_INGEST_TIMEOUT_MS env var support, validated the same way postfix-bridge validates its own numeric env vars, feeding MtaIngestClient's and the AWS SDK clients' timeouts alike, and wire it through the CDK stack as a new mtaIngestTimeoutMs prop for parity with postfix-bridge's identically-named env var

### Changed
- Moved SesMailTransport back to restapi repo
- Run the ingest Lambda inside a VPC when SES_BRIDGE_VPC_ID and SES_BRIDGE_SUBNET_IDS are set (with optional SES_BRIDGE_AVAILABILITY_ZONES), so it can reach a server whose /internal/mta is an internal load balancer rather than a public host, as it is for a server deployed by the RapidMX server's deploy/aws
- Create a security group for the Lambda in that VPC and output its id, so the server's ingest load balancer can allow it
- Describe the VPC attributes rather than looking them up, so cdk synth still runs without AWS credentials
- Document the new variables, the egress those subnets need and the security group output in the README and release notes
- Change ingestHandler to resolve a record's recipients against /internal/mta/resolve concurrently instead of one at a time, so a single slow recipient lookup no longer serializes the rest of that record's recipients behind it
- Bump the @rapidmx/restapi devDependency to ^0.19.0 and add a <1 upper bound to its peer range, matching every other sibling plugin's convention
- Document that the companion server/deploy/aws/rapidmx-server.yaml stack's PublicSubnet cannot be used for SES_BRIDGE_SUBNET_IDS, since it has no NAT gateway or VPC endpoints and a Lambda ENI never gets a public IP regardless of the subnet's route table, and add a cdk synth-time warning whenever a VPC is configured since this can't be verified against real route tables without a live AWS lookup
- Lower the ingest Lambda's own configured timeout from 30s to 25s so it fails with its own diagnosable Task timed out error instead of racing SES's separate ~30s ceiling for a synchronous receipt-rule Lambda action with no defined ordering between the two
- Upgraded deps
- Bump the @rapidmx/restapi development dependency to 0.21.1 and refresh the lockfile, leaving the peer range unchanged
- Document the bump in the release notes
- Document that a downstream package's release bump level follows its upstream dependency's, minor for minor, patch for patch and major for major, in NOTES

### Fixed
- Fixed lots of stuff
- Fixed MtaIngestClient.deliver() joining X-Envelope-To recipients with a bare comma, ambiguous whenever a quoted local part legally contains a literal comma, by percent-encoding every envelope address (encodeEnvelopeAddress, ported from postfix-bridge's identical fix) before it goes into X-Envelope-From/X-Envelope-To
- Fixed ingestHandler letting one record's failure reject the whole Lambda invocation, which risked a retry redelivering/re-bouncing every other already-succeeded record in the same event since a synchronous SES Lambda receipt action has no per-item failure reporting or DLQ; each record is now processed independently with failures logged and skipped
- Fixed ingestHandler's concurrent recipient resolution being all-or-nothing: Promise.all rejected and discarded every other recipient's already-computed result in a record when just one resolveRecipient() call threw, silently dropping the whole record; switch to Promise.allSettled and bounce a recipient whose lookup failed instead of taking its neighbors down with it
- Fixed the DSN bounce's ReportingMta being hardcoded to the literal dns; amazonses.com instead of reusing the already-computed senderDomain, and its ArrivalDate using the bounce's own wall-clock time instead of the original message's SES-recorded arrival time

### Added
- Initial scaffold: SesMailTransport (a MailTransport implementation for outbound mail via AWS SES), an ingestHandler Lambda translating SES receipt events into the same /internal/mta/resolve + /internal/mta/deliver calls postfix-bridge makes, and a CDK app provisioning the S3 bucket/receipt rule/Lambda/IAM role this needs

[Unreleased]: https://github.com/rapidmx/ses-bridge/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/rapidmx/ses-bridge/releases/tag/v0.1.1
