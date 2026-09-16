# Release Notes

## Unreleased

Bridges a RapidMX server's outbound `MailTransport` interface and inbound `/internal/mta` ingest
contract to AWS SES.

* Added `SES_BRIDGE_VPC_ID` and `SES_BRIDGE_SUBNET_IDS` (with optional `SES_BRIDGE_AVAILABILITY_ZONES`),
  which run the ingest Lambda inside a VPC so it can reach a server whose `/internal/mta` isn't public -
  as it isn't for a server deployed by `server/deploy/aws`, where it is an internal load balancer. The
  stack then creates a security group for the Lambda and outputs its id. Those subnets need egress (NAT
  or VPC endpoints) for the handler's S3 reads and SES bounces.
