# Release Notes

## Unreleased

Bridges a RapidMX server's outbound `MailTransport` interface and inbound `/internal/mta` ingest
contract to AWS SES.

* Added `SES_BRIDGE_VPC_ID` and `SES_BRIDGE_SUBNET_IDS` (with optional `SES_BRIDGE_AVAILABILITY_ZONES`),
  which run the ingest Lambda inside a VPC so it can reach a server whose `/internal/mta` isn't public -
  as it isn't for a server deployed by `server/deploy/aws`, where it is an internal load balancer. The
  stack then creates a security group for the Lambda and outputs its id. Those subnets need egress (NAT
  or VPC endpoints) for the handler's S3 reads and SES bounces.
* Fixed `MtaIngestClient.deliver()` joining multiple `X-Envelope-To` recipients with a bare `,`, which was
  ambiguous whenever an address's quoted local part legally contained a literal comma (RFC 5321) - every
  envelope address is now percent-encoded (`encodeURIComponent`) before being written into
  `X-Envelope-From`/`X-Envelope-To`, matching `postfix-bridge`'s identical fix for the same shared HTTP
  contract.
* Added a per-call timeout (`AbortSignal.timeout`, 10s default) to every `MtaIngestClient` upstream call, so
  a stalled `restapi` response fails fast instead of silently consuming the ingest Lambda's entire
  remaining execution budget.
* Changed `ingestHandler` to resolve a record's recipients against `/internal/mta/resolve` concurrently
  instead of one at a time, so a single slow recipient lookup no longer serializes the rest of that
  record's recipients behind it.
* Fixed `ingestHandler` letting one record's failure reject the whole Lambda invocation - since a
  synchronous SES Lambda receipt action has no per-item failure reporting, that would cause a retry to
  redeliver/re-bounce every other, already-succeeded record in the same event. Each record is now
  processed independently; a failing record is logged (CloudWatch) and skipped without affecting the rest.
* Bumped the `@rapidmx/restapi` devDependency to `^0.19.0` and added a `<1` upper bound to its peer range,
  matching every other sibling plugin's convention.
* Fixed `ingestHandler`'s concurrent recipient resolution being all-or-nothing: one recipient's
  `resolveRecipient()` call throwing used to reject and discard every OTHER recipient's already-computed
  result in the same record too, silently dropping the whole record. A recipient whose lookup fails is now
  bounced (like an explicit "doesn't resolve") instead of taking its neighbors down with it.
* Added a request timeout (10s default, matching `MtaIngestClient`) to the `S3Client`/`SESClient` instances
  `ingestHandler` uses, closing the same "hung call silently consumes the Lambda's whole execution budget"
  problem the `MtaIngestClient` timeout closed last round, for the S3/SES calls this time.
* Fixed the DSN bounce's `ReportingMta` being hardcoded to `dns; amazonses.com` instead of the bounced
  recipient's own domain (`senderDomain`, already computed for `BounceSender`), and its `ArrivalDate` using
  the bounce's own wall-clock time instead of the original message's SES-recorded arrival time.
* Added `MTA_INGEST_TIMEOUT_MS` support (validated the same way `postfix-bridge` validates its own env
  vars: a positive number if set, or the 10s default), threaded through the CDK stack as a new optional
  `mtaIngestTimeoutMs` prop, for parity with `postfix-bridge`'s identically-named env var.
* Lowered the ingest Lambda's own configured timeout from 30s to 25s, so it produces its own distinctly
  diagnosable "Task timed out" error instead of racing against SES's separate ~30s ceiling for a synchronous
  receipt-rule Lambda action with no defined ordering between the two.
* Documented (README and a synth-time CDK warning whenever a VPC is configured) that the companion
  `server/deploy/aws/rapidmx-server.yaml` stack's own `PublicSubnet` cannot be used for
  `SES_BRIDGE_SUBNET_IDS` - it has no NAT gateway or VPC endpoints, and a Lambda's VPC network interface
  never gets a public IP regardless of the subnet's route table, so using it gives the ingest Lambda zero
  egress and silently drops all inbound mail.
