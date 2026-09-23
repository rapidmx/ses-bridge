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
