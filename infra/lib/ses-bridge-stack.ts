///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as path from "path";
import { fileURLToPath } from "url";
import { Annotations, CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { IVpc, SecurityGroup, SubnetSelection, Vpc } from "aws-cdk-lib/aws-ec2";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import { EmailIdentity, Identity, ReceiptRuleSet } from "aws-cdk-lib/aws-ses";
import { Lambda as LambdaAction, LambdaInvocationType, S3 as S3Action } from "aws-cdk-lib/aws-ses-actions";
import { Construct } from "constructs";

const moduleDir: string = path.dirname(fileURLToPath(import.meta.url));

export interface SesBridgeStackProps extends StackProps {
    /** The mail domain SES verifies, receives for, and (via `SesMailTransport`) sends as. Only one domain
     * per stack instance - deploy a second stack for a second domain. */
    readonly domainName: string;

    /** Base URL of the RapidMX server's `/internal/mta` contract this bridge forwards to - e.g.
     * `https://mail.example.com/internal/mta`. A server deployed by this project's own CloudFormation
     * template (`server/deploy/aws`) keeps that API off the public internet, so the URL is its internal
     * load balancer's and `vpcId`/`subnetIds` below are required to reach it. */
    readonly mtaIngestBaseUrl: string;

    /** The VPC to run `ingestHandler` inside, so it can reach a `mtaIngestBaseUrl` that isn't public -
     * the RapidMX server chart's `mail.ingestService` load balancer is internal to its own VPC. Requires
     * `subnetIds`. Left unset, the Lambda runs outside any VPC and `mtaIngestBaseUrl` must be reachable
     * from the internet. */
    readonly vpcId?: string;

    /** Subnets in `vpcId` to place `ingestHandler` in. They need a route to the internet (a NAT gateway,
     * i.e. private subnets) or VPC endpoints for S3 and SES: the handler reads each raw message from S3
     * and bounces through SES, neither of which it can reach from a subnet with no egress.
     *
     * **This is not optional and the companion server stack does not provide it.** A Lambda's VPC ENI
     * never gets a public IP, regardless of the subnet's own route table - so a subnet routed only to an
     * `InternetGateway` (a "public" subnet in the usual EC2/ALB sense) gives this Lambda *zero* egress, not
     * reduced egress. `server/deploy/aws/rapidmx-server.yaml` (the only companion deployment this repo's
     * own docs point at) provisions exactly one such subnet (`PublicSubnet`, routed only to its
     * `InternetGateway` - no NAT gateway, no VPC endpoints anywhere in that template) and nothing else -
     * passing that subnet here silently breaks every inbound message: `fetchRawMessage`/`SendBounce`/
     * `deliver` all hang until their own timeout, the per-record `catch` this repo added logs each one and
     * moves on, and the net effect is 100% of inbound mail dropped with no error surfaced beyond a
     * CloudWatch line and no bounce sent either. A private subnet with a NAT gateway, or VPC endpoints for
     * S3 and SES, must be created separately - this stack cannot verify that at `cdk synth` time (see
     * `availabilityZones`'s own doc comment for why this stack deliberately never looks the VPC up live),
     * so it emits a synth-time warning instead whenever a VPC is configured (see the constructor). */
    readonly subnetIds?: string[];

    /** The availability zones of `subnetIds`, in the same order. Only needed because this stack
     * describes the VPC by its attributes rather than looking it up, so that `cdk synth` needs no AWS
     * credentials.
     *
     * @default the region's own zones, in order */
    readonly availabilityZones?: string[];

    /**
     * Bearer secret authenticating `ingestHandler`'s calls to `mtaIngestBaseUrl` - must match that
     * server's own `mail__transport__ingest__secret` exactly.
     *
     * **Known v1 simplification, not a considered final design**: this is passed as a plain Lambda
     * environment variable, visible in the Lambda console and this stack's own CloudFormation template -
     * fine for initial evaluation, but a real production deployment should switch this to a Secrets
     * Manager secret ARN that `ingestHandler` resolves at runtime instead. Tracked as a follow-up, not
     * solved in this scaffold.
     */
    readonly mtaIngestSecret: string;

    /** Key prefix SES's S3 receipt action stores raw messages under, and `ingestHandler` must derive the
     * same object key from (`<prefix><mail.messageId>` - see `src/lambda/ingestHandler.ts`'s own doc
     * comment for why this isn't just read back off the event). Include a trailing `/` if set.
     *
     * @default "inbound/" */
    readonly objectKeyPrefix?: string;

    /** How long (milliseconds) every upstream call `ingestHandler` makes - to `mtaIngestBaseUrl` and to
     * S3/SES - may take before it gives up on that one call. Passed straight through as the Lambda's own
     * `MTA_INGEST_TIMEOUT_MS` environment variable; `ingestHandler`'s own `requirePositiveNumber()` is what
     * actually validates and defaults it (to `MtaIngestClient`'s `DEFAULT_MTA_INGEST_TIMEOUT_MS`, 10s) at
     * cold start, so an unset or malformed value here just falls through to that runtime default/failure
     * rather than being re-validated at synth time. Same env var name as `postfix-bridge`'s own
     * `MTA_INGEST_TIMEOUT_MS`, for parity. Left as a raw string (not `number`) deliberately - CDK/Lambda
     * environment variables are always strings, so accepting a string here avoids a pointless
     * number-to-string-to-number round trip for a value this stack itself never needs to interpret. */
    readonly mtaIngestTimeoutMs?: string;
}

/**
 * Provisions everything `ingestHandler` needs to receive mail for `domainName` via SES: a verified email
 * identity (Easy DKIM - see this repo's `.claude/NOTES.md` for why RapidMX's own `DkimKeyProvider`
 * machinery is deliberately not used here), an S3 bucket to stage raw messages, the Lambda itself, and a
 * receipt rule chaining an `S3` action to a synchronous `Lambda` action - see `ingestHandler`'s own doc
 * comment for the per-invocation flow.
 *
 * **What this stack deliberately does NOT do** (see this repo's README for the full manual runbook):
 * - Does not verify the `domainName` identity for you beyond issuing the DKIM CNAME tokens as
 * `CfnOutput`s - publishing them to the domain's actual DNS provider is a manual step, since this
 * stack has no way to know (or be trusted with credentials for) that provider.
 * - Does not publish the MX record pointing `domainName` at SES's inbound endpoint - same reason.
 * - Does not mark the `ReceiptRuleSet` this stack creates as the account's *active* rule set -
 * CloudFormation has no resource for that (`ses:SetActiveReceiptRuleSet` isn't a declarative
 * operation); run the AWS CLI command this stack's own `CfnOutput` prints after every deploy.
 *
 * @author Jean-Philippe Steinmetz
 */
export class SesBridgeStack extends Stack {
    public constructor(scope: Construct, id: string, props: SesBridgeStackProps) {
        super(scope, id, props);

        const objectKeyPrefix: string = props.objectKeyPrefix ?? "inbound/";

        const identity: EmailIdentity = new EmailIdentity(this, "Identity", {
            identity: Identity.domain(props.domainName),
            // dkimSigning defaults to true (Easy DKIM, 2048-bit) - explicit here so this stack's own
            // intent survives a future aws-cdk-lib default change.
            dkimSigning: true,
        });

        // Transient hand-off storage only - `/internal/mta/deliver` persists to RapidMX's own BlobStore
        // immediately, so nothing here needs to survive longer than it takes `ingestHandler` to read it
        // back (a lifecycle rule, not `ingestHandler` itself, is the actual cleanup mechanism - the
        // handler never deletes what it reads, matching how a real MTA doesn't delete a message it
        // couldn't confirm was durably queued downstream).
        const bucket: Bucket = new Bucket(this, "InboundBucket", {
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            lifecycleRules: [{ expiration: Duration.days(7), prefix: objectKeyPrefix }],
            removalPolicy: RemovalPolicy.RETAIN,
        });

        // Inside a VPC only when asked for: a Lambda with no VPC reaches a public mtaIngestBaseUrl directly,
        // while one in a VPC loses that default internet access and depends on the subnets' own egress.
        let vpc: IVpc | undefined;
        let vpcSubnets: SubnetSelection | undefined;
        let ingestSecurityGroup: SecurityGroup | undefined;
        if (props.vpcId) {
            if (!props.subnetIds || props.subnetIds.length === 0) {
                throw new Error("subnetIds is required with vpcId: the Lambda needs subnets to run in.");
            }
            vpc = Vpc.fromVpcAttributes(this, "Vpc", {
                vpcId: props.vpcId,
                // Describing the VPC rather than Vpc.fromLookup() keeps `cdk synth` credential-free (see
                // infra/bin/app.ts). Only the subnets below are ever used from it.
                availabilityZones: props.availabilityZones ?? Fn.getAzs(),
                privateSubnetIds: props.subnetIds,
            });
            // The subnets given, in the order given: fromVpcAttributes' privateSubnetIds are what it returns here.
            vpcSubnets = { subnets: vpc.privateSubnets };
            // Can't verify the given subnets actually have egress (NAT gateway / VPC endpoints) at synth
            // time without a live AWS lookup, which this stack deliberately avoids (see `subnetIds`' own
            // doc comment). A synth-time warning is the next best thing - it surfaces in `cdk diff`/`cdk
            // deploy` output every time a VPC is configured, not just on first setup, which matters because
            // `server/deploy/aws/rapidmx-server.yaml`'s only subnet (`PublicSubnet`) looks superficially
            // reusable (it exists, it's in the right VPC) while actually giving this Lambda zero egress.
            Annotations.of(this).addWarning(
                "ingestHandler is configured to run in a VPC. Its subnets MUST have egress to the internet " +
                    "(a NAT gateway in a private subnet) or VPC endpoints for S3 and SES - otherwise every " +
                    "inbound message silently fails (raw-message fetch, bounce, and delivery all hang until " +
                    "timeout, then get logged and dropped with no bounce sent). The companion " +
                    "server/deploy/aws/rapidmx-server.yaml stack's own PublicSubnet does NOT provide this: " +
                    "it is routed only to an InternetGateway with no NAT gateway or VPC endpoints, and a " +
                    "Lambda ENI never gets a public IP regardless of the subnet's route table. This cannot " +
                    "be verified automatically at synth time - confirm it manually before deploying.",
            );
            ingestSecurityGroup = new SecurityGroup(this, "IngestHandlerSecurityGroup", {
                vpc,
                description: "RapidMX ses-bridge ingest handler",
                // Outbound only: to the server's internal load balancer, S3 and SES. Nothing connects to it.
                allowAllOutbound: true,
            });
        }

        const ingestFn: NodejsFunction = new NodejsFunction(this, "IngestHandler", {
            entry: path.join(moduleDir, "../../src/lambda/ingestHandler.ts"),
            handler: "handler",
            runtime: Runtime.NODEJS_24_X,
            // Deliberately below, not equal to, SES's own ~30s ceiling for a synchronous receipt-rule
            // Lambda action (per AWS's documented behavior for this invocation type - not independently
            // re-verified against a live deployment this session). Setting this to exactly 30s would race
            // this function's own timeout against SES's separate, external cutoff with no way to know which
            // fires first; this function's own "Task timed out" error is far more diagnosable in CloudWatch
            // than whatever SES logs when it just stops waiting on its side. This margin does NOT buy more
            // actual processing time - SES's own ceiling is the true hard limit either way - it only makes
            // a timeout fail predictably and loudly instead of racing. See .claude/NOTES.md for the fuller
            // writeup and the caveat that the exact SES-side number isn't independently confirmed here.
            timeout: Duration.seconds(25),
            vpc,
            vpcSubnets,
            securityGroups: ingestSecurityGroup ? [ingestSecurityGroup] : undefined,
            environment: {
                MTA_INGEST_BASE_URL: props.mtaIngestBaseUrl,
                MTA_INGEST_SECRET: props.mtaIngestSecret,
                SES_BUCKET_NAME: bucket.bucketName,
                SES_OBJECT_KEY_PREFIX: objectKeyPrefix,
                // Omitted entirely (rather than set to an empty string) when unset, so `ingestHandler`'s own
                // `requirePositiveNumber()` sees a genuinely-unset env var and falls through to its own
                // default instead of failing on an empty string.
                ...(props.mtaIngestTimeoutMs ? { MTA_INGEST_TIMEOUT_MS: props.mtaIngestTimeoutMs } : {}),
            },
        });
        bucket.grantRead(ingestFn, `${objectKeyPrefix}*`);
        // `ses:SendBounce` has no documented resource-level restriction narrower than "*" - see
        // ingestHandler.ts's own bounceRecipients() for why this Lambda needs it at all.
        ingestFn.addToRolePolicy(
            new PolicyStatement({
                actions: ["ses:SendBounce"],
                resources: ["*"],
            }),
        );

        const ruleSet: ReceiptRuleSet = new ReceiptRuleSet(this, "ReceiptRuleSet");
        // `S3` then `Lambda`, in that order, in the SAME rule - the Lambda action's synchronous
        // (RequestResponse) invocation reads back what the S3 action just stored (see
        // ingestHandler.ts's objectKeyFor() doc comment for the naming convention it depends on). Both
        // actions' own IAM/bucket-policy wiring (SES's permission to write to `bucket`, SES's permission
        // to invoke `ingestFn`) is handled automatically by these two construct classes - nothing to add
        // here.
        ruleSet.addRule("IngestRule", {
            recipients: [props.domainName],
            actions: [
                new S3Action({ bucket, objectKeyPrefix }),
                new LambdaAction({ function: ingestFn, invocationType: LambdaInvocationType.REQUEST_RESPONSE }),
            ],
        });

        new CfnOutput(this, "DkimRecords", {
            description: `Publish these 3 CNAME records for ${props.domainName} to complete Easy DKIM setup and domain verification`,
            value: identity.dkimRecords.map((r) => `${r.name} CNAME ${r.value}`).join(" | "),
        });
        new CfnOutput(this, "MxRecordValue", {
            description: `Point ${props.domainName}'s MX record at this value (priority 10) to receive mail via this stack`,
            value: `10 inbound-smtp.${Stack.of(this).region}.amazonaws.com`,
        });
        if (ingestSecurityGroup) {
            new CfnOutput(this, "IngestHandlerSecurityGroupId", {
                description:
                    "The ingest handler's security group - allow it on the server's internal ingest load balancer " +
                    "(the chart's mail.ingestService.loadBalancerSourceRanges covers this by CIDR instead)",
                value: ingestSecurityGroup.securityGroupId,
            });
        }
        new CfnOutput(this, "ActivateRuleSetCommand", {
            description: "Run this after every deploy - CloudFormation cannot mark a receipt rule set active",
            value: `aws ses set-active-receipt-rule-set --rule-set-name ${ruleSet.receiptRuleSetName}`,
        });
    }
}
