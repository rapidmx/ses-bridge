///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as path from "path";
import { fileURLToPath } from "url";
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
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
     * `https://mail.example.com/internal/mta`. See this repo's README for the VPC-networking
     * prerequisite if `server` isn't reachable from the public internet. */
    readonly mtaIngestBaseUrl: string;

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

        const ingestFn: NodejsFunction = new NodejsFunction(this, "IngestHandler", {
            entry: path.join(moduleDir, "../../src/lambda/ingestHandler.ts"),
            handler: "handler",
            runtime: Runtime.NODEJS_24_X,
            timeout: Duration.seconds(30),
            environment: {
                MTA_INGEST_BASE_URL: props.mtaIngestBaseUrl,
                MTA_INGEST_SECRET: props.mtaIngestSecret,
                SES_BUCKET_NAME: bucket.bucketName,
                SES_OBJECT_KEY_PREFIX: objectKeyPrefix,
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
        new CfnOutput(this, "ActivateRuleSetCommand", {
            description: "Run this after every deploy - CloudFormation cannot mark a receipt rule set active",
            value: `aws ses set-active-receipt-rule-set --rule-set-name ${ruleSet.receiptRuleSetName}`,
        });
    }
}
