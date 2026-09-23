///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendBounceCommand, SESClient } from "@aws-sdk/client-ses";
import { SESEvent, SESEventRecord } from "aws-lambda";
import { DEFAULT_MTA_INGEST_TIMEOUT_MS, MtaIngestClient } from "./MtaIngestClient.js";

function requireEnv(name: string): string {
    const value: string | undefined = process.env[name];
    if (!value) {
        throw new Error(`${name} must be set (no default available).`);
    }
    return value;
}

/**
 * Parses a numeric env var, falling back to `fallback` when unset, but failing fast (rather than silently
 * falling back to something unbounded/nonsensical) when it's *set* to something that isn't a positive,
 * finite number - same helper (and same rationale) as `postfix-bridge`'s own `src/index.ts`. A blank or
 * malformed `MTA_INGEST_TIMEOUT_MS` would otherwise reach `AbortSignal.timeout()`, which throws
 * synchronously for `NaN`/a negative number, so every call would fail from the very first invocation
 * rather than at cold-start where it's easier to diagnose.
 */
function requirePositiveNumber(name: string, fallback: number): number {
    const raw: string | undefined = process.env[name];
    if (raw === undefined) {
        return fallback;
    }
    const value: number = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive number if set (got '${raw}').`);
    }
    return value;
}

// How long every upstream call (to `restapi` via MtaIngestClient, and to S3/SES via the AWS SDK clients
// below) may take before this Lambda gives up on it rather than silently spending its whole remaining
// execution budget on one hung call - see MtaIngestClient's own `timeoutMs` doc for why. Configurable for
// parity with postfix-bridge's identically-named `MTA_INGEST_TIMEOUT_MS`, which was previously always
// hardcoded here to MtaIngestClient's own default.
const ingestTimeoutMs: number = requirePositiveNumber("MTA_INGEST_TIMEOUT_MS", DEFAULT_MTA_INGEST_TIMEOUT_MS);

// AWS SDK v3 clients have NO request timeout by default (`@smithy/node-http-handler`'s own
// `DEFAULT_REQUEST_TIMEOUT` is `0`, meaning "disabled") - without this, a hung `s3:GetObject` or
// `ses:SendBounce` call would reopen exactly the "silently consumes the whole Lambda budget" problem
// `MtaIngestClient`'s `timeoutMs` was added to close last round, just for the AWS SDK calls instead of the
// `fetch()` ones. `throwOnRequestTimeout` is required for `requestTimeout` to actually reject the call
// instead of merely logging a warning (see `NodeHttpHandlerOptions`'s own doc comment) - a rejection is
// what lets this hung call reach `handler()`'s per-record `catch` and fail that one record instead of
// silently stalling.
const awsClientOptions = {
    requestHandler: {
        connectionTimeout: ingestTimeoutMs,
        requestTimeout: ingestTimeoutMs,
        throwOnRequestTimeout: true,
    },
};

// Lambda execution environments reuse a warm container across invocations, so everything below that
// doesn't depend on a specific event (clients, config) is deliberately created once at module load, not
// per-invocation - the standard Lambda cold-start-cost-amortization pattern.
const ingestClient: MtaIngestClient = new MtaIngestClient(
    requireEnv("MTA_INGEST_BASE_URL"),
    requireEnv("MTA_INGEST_SECRET"),
    ingestTimeoutMs,
);
const s3Client: S3Client = new S3Client(awsClientOptions);
const sesClient: SESClient = new SESClient(awsClientOptions);
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
                // "dns; <domain>" per RFC 3464/AWS's own documented convention - the domain that owns the
                // bounced mailbox, not a generic AWS hostname (`senderDomain` is already derived above for
                // `BounceSender`; this reuses the same value rather than hardcoding an unrelated literal).
                ReportingMta: `dns; ${senderDomain}`,
                // The message's actual SES-recorded arrival time, not the bounce's own wall-clock time -
                // the SES event already carries it (`record.ses.mail.timestamp`).
                ArrivalDate: new Date(record.ses.mail.timestamp),
            },
            Explanation: "The recipient's mailbox does not exist.",
        }),
    );
}

/**
 * Resolves every recipient of one record concurrently against `GET /internal/mta/resolve`, splitting them
 * into `resolved`/`unresolved` in the same order `receipt.recipients` gave them (`Promise.allSettled`
 * preserves result order regardless of completion order, so concurrency here doesn't change
 * `bounceRecipients()`'s `recipients[0]`-derived `BounceSender` behavior). Run concurrently rather than one
 * at a time so a single slow recipient lookup doesn't serialize the rest of this record's own recipients
 * behind it - see `MtaIngestClient`'s `timeoutMs` doc for the complementary fix (a hung call now fails fast
 * instead of consuming the Lambda's whole remaining budget).
 *
 * Deliberately `Promise.allSettled`, not `Promise.all`: `resolveRecipient()` throws on anything other than
 * a definitive 200/404 (see its own doc comment), and `Promise.all` is all-or-nothing - one recipient
 * hitting a transient error would reject the whole array and discard every OTHER recipient's
 * already-computed result too, silently dropping an entire multi-recipient record (no delivery, no bounce,
 * just a `console.error`) over one recipient's transient failure. A recipient whose lookup threw is treated
 * the same as an explicit "doesn't resolve" (pushed to `unresolved`, so it gets bounced) rather than
 * aborting its neighbors. This is a real, if imperfect, trade-off: a transient lookup failure now produces
 * a "mailbox doesn't exist" DSN for an address that might actually be valid, rather than the mail silently
 * vanishing - preferred here since the sender at least gets a (possibly-wrong) bounce instead of nothing at
 * all, and because `resolveRecipient()`'s own failure semantics already document why network errors and
 * "genuinely not found" ought to be distinguished by *this* function's caller, not conflated - logging each
 * such failure keeps that distinction visible in CloudWatch even though the bounce itself can't carry it.
 */
async function resolveRecipients(recipients: string[]): Promise<{ resolved: string[]; unresolved: string[] }> {
    const settled = await Promise.allSettled(recipients.map((recipient) => ingestClient.resolveRecipient(recipient)));
    const resolved: string[] = [];
    const unresolved: string[] = [];
    settled.forEach((result, i) => {
        const recipient: string = recipients[i];
        if (result.status === "fulfilled" && result.value) {
            resolved.push(recipient);
            return;
        }
        if (result.status === "rejected") {
            console.error(`ingestHandler: resolveRecipient('${recipient}') failed, bouncing it instead:`, result.reason);
        }
        unresolved.push(recipient);
    });
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
