///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendBounceCommand, SESClient } from "@aws-sdk/client-ses";
import { SESEvent, SESEventRecord } from "aws-lambda";
import { MtaIngestClient } from "./MtaIngestClient.js";

function requireEnv(name: string): string {
    const value: string | undefined = process.env[name];
    if (!value) {
        throw new Error(`${name} must be set (no default available).`);
    }
    return value;
}

// Lambda execution environments reuse a warm container across invocations, so everything below that
// doesn't depend on a specific event (clients, config) is deliberately created once at module load, not
// per-invocation - the standard Lambda cold-start-cost-amortization pattern.
const ingestClient: MtaIngestClient = new MtaIngestClient(requireEnv("MTA_INGEST_BASE_URL"), requireEnv("MTA_INGEST_SECRET"));
const s3Client: S3Client = new S3Client({});
const sesClient: SESClient = new SESClient({});
const bucketName: string = requireEnv("SES_BUCKET_NAME");
const objectKeyPrefix: string = process.env.SES_OBJECT_KEY_PREFIX ?? "";

/**
 * SES's S3 receipt action names the stored object `<objectKeyPrefix><mail.messageId>`, with no
 * extension - a documented, deterministic convention (see AWS's `S3Action` docs), not something the
 * receipt event payload repeats back to a chained Lambda action. `objectKeyPrefix` here MUST match
 * exactly what `infra/lib/ses-bridge-stack.ts` configures on the S3 action, or every lookup below 404s.
 *
 * **Not verified against a live SES deployment this session** - built directly from AWS's documented S3
 * action behavior, not confirmed by triggering a real receipt rule end to end. If messages aren't being
 * found in S3, confirm this convention still holds and that the prefix matches first.
 */
function objectKeyFor(messageId: string): string {
    return `${objectKeyPrefix}${messageId}`;
}

async function fetchRawMessage(messageId: string): Promise<Buffer> {
    const res = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: objectKeyFor(messageId) }));
    const bytes: Uint8Array = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
}

/**
 * Sends a proper DSN bounce for exactly `recipients` of `record` via `ses:SendBounce` - deliberately
 * per-recipient rather than a receipt-rule-level `Bounce` action, since the latter would bounce every
 * recipient of the whole transaction even when only some of several are actually invalid (see this
 * repo's `.claude/NOTES.md` for why this "accept, then bounce" shape was chosen over a live SMTP-time
 * reject in the first place - SES has no synchronous pre-accept hook the way Postfix's `tcp_table` does).
 *
 * `BounceSender` is derived from `recipients[0]`'s own domain, not `record`'s other recipients - a
 * simplification that assumes a single receipt rule doesn't mix multiple receiving domains in one
 * invocation. Revisit if that ever stops being true for a given deployment.
 */
async function bounceRecipients(record: SESEventRecord, recipients: string[]): Promise<void> {
    if (recipients.length === 0) {
        return;
    }

    const senderDomain: string = recipients[0].split("@")[1] ?? "localhost";
    await sesClient.send(
        new SendBounceCommand({
            OriginalMessageId: record.ses.mail.messageId,
            BounceSender: `mailer-daemon@${senderDomain}`,
            BouncedRecipientInfoList: recipients.map((recipient) => ({
                Recipient: recipient,
                BounceType: "DoesNotExist",
            })),
            MessageDsn: {
                ReportingMta: "dns; amazonses.com",
                ArrivalDate: new Date(),
            },
            Explanation: "The recipient's mailbox does not exist.",
        }),
    );
}

/**
 * Resolves every recipient of one record concurrently against `GET /internal/mta/resolve`, splitting them
 * into `resolved`/`unresolved` in the same order `receipt.recipients` gave them (`Promise.all` preserves
 * result order regardless of completion order, so concurrency here doesn't change `bounceRecipients()`'s
 * `recipients[0]`-derived `BounceSender` behavior). Run concurrently rather than one at a time so a single
 * slow recipient lookup doesn't serialize the rest of this record's own recipients behind it - see
 * `MtaIngestClient`'s `timeoutMs` doc for the complementary fix (a hung call now fails fast instead of
 * consuming the Lambda's whole remaining budget).
 */
async function resolveRecipients(recipients: string[]): Promise<{ resolved: string[]; unresolved: string[] }> {
    const results = await Promise.all(
        recipients.map(async (recipient) => ({ recipient, exists: await ingestClient.resolveRecipient(recipient) })),
    );
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const { recipient, exists } of results) {
        (exists ? resolved : unresolved).push(recipient);
    }
    return { resolved, unresolved };
}

/**
 * Entry point for the receipt rule's synchronous Lambda action - see `infra/lib/ses-bridge-stack.ts` for
 * how the receipt rule is wired (an `S3` action storing the raw message, immediately followed by this
 * function as a `Lambda` action in the same rule). For each record: resolves every recipient this rule
 * matched against `GET /internal/mta/resolve`, bounces the ones that don't resolve, and - for the rest -
 * fetches the raw message from S3 and hands it to `POST /internal/mta/deliver` in one call (mirroring
 * `postfix-bridge`'s own "one SMTP transaction, one `deliver()` call" contract usage).
 *
 * Each record is processed independently, inside its own `try`/`catch` - deliberately, so that one
 * record's failure can't reject this whole invocation. This isn't optional hardening: `event.Records` can
 * hold more than one record, and a synchronous (`RequestResponse`) SES Lambda receipt action has no
 * SQS-style per-item failure reporting - if this function rejects, SES retries the *entire* invocation, not
 * just the record that failed. Without this isolation, a transient failure on record 2 of 2 would cause a
 * retry that redelivers/re-bounces record 1 a second time, even though record 1 already succeeded. A
 * synchronous invocation also can't be given a Lambda on-failure destination/DLQ - those only attach to
 * asynchronous (`Event`) invocations - so a `console.error` line (CloudWatch Logs) is the failure-visibility
 * mechanism available here; there is currently no DLQ or on-failure destination configured for this
 * function in `infra/lib/ses-bridge-stack.ts`, and none can be for this invocation type.
 *
 * Returns `STOP_RULE_SET` only when nothing in this invocation resolved to a real mailbox/list -
 * meaningful only if a deployment ever chains further rules after this one; harmless no-op otherwise.
 */
export async function handler(event: SESEvent): Promise<{ disposition: "CONTINUE" | "STOP_RULE_SET" }> {
    let anyDelivered: boolean = false;

    for (const record of event.Records) {
        const { mail, receipt } = record.ses;

        try {
            const { resolved, unresolved } = await resolveRecipients(receipt.recipients);

            await bounceRecipients(record, unresolved);

            if (resolved.length > 0) {
                const raw: Buffer = await fetchRawMessage(mail.messageId);
                await ingestClient.deliver(mail.source, resolved, raw);
                anyDelivered = true;
            }
        } catch (err) {
            // Swallow and move on to the next record - see this function's own doc comment for why the
            // whole invocation must not fail just because one record did.
            console.error(`ingestHandler: failed to process message '${mail.messageId}':`, err);
        }
    }

    return { disposition: anyDelivered ? "CONTINUE" : "STOP_RULE_SET" };
}
