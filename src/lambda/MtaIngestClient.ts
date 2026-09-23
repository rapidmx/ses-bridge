///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** Default per-call timeout (ms) for every upstream HTTP call this client makes - see the constructor's
 * `timeoutMs` doc for why this exists at all. */
export const DEFAULT_MTA_INGEST_TIMEOUT_MS = 10_000;

/**
 * Percent-encodes an envelope address (`MAIL FROM`/`RCPT TO`) for safe transport as an HTTP header value.
 *
 * This closes two problems at once. First, `deliver()` joins multiple `RCPT TO` addresses into one
 * `X-Envelope-To` header with `,` as the separator, but RFC 5321 permits a literal comma inside a quoted
 * local part (e.g. `"a,b"@example.com`), and SES's own envelope validation only needs to satisfy SMTP
 * grammar, not forbid that - it accepts that address unchanged, quotes and comma included. An unescaped
 * comma there would make the joined header ambiguous to split back apart correctly on the receiving end.
 * Second, RFC 6531 (SMTPUTF8) legally allows non-ASCII UTF-8 bytes in the local part, which would
 * otherwise be written directly into an HTTP header value - `encodeURIComponent` keeps every header byte
 * within the safe/printable ASCII range `fetch`/undici require.
 *
 * Identical to (and deliberately kept in lockstep with) `postfix-bridge`'s own `encodeEnvelopeAddress` -
 * this bridge implements the same `MTAIngestAdapter` HTTP contract (see the class doc below), so the
 * header format on the wire must match regardless of which MTA produced the envelope.
 *
 * NOTE: the receiving end (`@rapidmx/restapi`'s `BaseMailIngestRoute.deliver()`) currently splits
 * `X-Envelope-To` on a bare `,` and uses each segment as the literal address - it does not yet
 * `decodeURIComponent` its segments. That companion fix belongs to that repo; until it lands, this change
 * guarantees the *count* of recipients survives a comma-containing address intact (no extra, garbled
 * recipient is synthesized), which is the security-relevant half of this fix, without regressing what the
 * plain, common case (no reserved characters) looks like on the wire.
 */
function encodeEnvelopeAddress(address: string): string {
    return encodeURIComponent(address);
}

/**
 * Thin HTTP client for the `MTAIngestAdapter` contract this bridge's `ingestHandler` Lambda translates
 * SES receipt events into - see `@rapidmx/restapi`'s `src/transport/MTAIngestAdapter.ts` for the
 * authoritative contract (`GET /internal/mta/domain`, `GET /internal/mta/resolve`,
 * `POST /internal/mta/deliver`), which this class is deliberately kept in lockstep with. Identical in
 * shape to `postfix-bridge`'s own `MtaIngestClient` - the contract doesn't change based on which MTA is
 * on the other end of it.
 *
 * Talks over HTTP(S) from wherever the Lambda actually runs (a VPC-attached ENI, if `server` sits in a
 * private VPC - see this repo's README) to `server`'s `/internal/mta` endpoint - the bearer secret, not
 * network topology alone, is this contract's stated security boundary (see
 * `BaseMailIngestRoute.authorizeInternalCaller()`).
 *
 * @author Jean-Philippe Steinmetz
 */
export class MtaIngestClient {
    public constructor(
        private readonly baseUrl: string,
        private readonly secret: string,
        /** Every `fetch()` call below aborts after this many milliseconds. This class runs inside
         * `ingestHandler`, a Lambda with its own hard function timeout (`infra/lib/ses-bridge-stack.ts`
         * sets 30s) - without a timeout here, a single hung upstream call wouldn't hang "forever" so much
         * as silently consume the Lambda's *entire* remaining budget, starving every other recipient and
         * every other record in the same invocation from being resolved, bounced, or delivered at all (see
         * `ingestHandler.ts`'s own per-record handling). Deliberately not caught/mapped here - `fetch`'s
         * own `TimeoutError` rejection propagates exactly like any other network failure to
         * `ingestHandler`'s per-record `catch`, which logs it and moves on to the next record instead of
         * letting one hung call sink the whole invocation. */
        private readonly timeoutMs: number = DEFAULT_MTA_INGEST_TIMEOUT_MS,
    ) {}

    private authHeader(): Record<string, string> {
        return { Authorization: `Bearer ${this.secret}` };
    }

    /** `GET /internal/mta/domain?name=<domain>` - `true` if this deployment accepts mail for `domain` at
     * all. Throws on anything other than a definitive 200/404, so the caller can distinguish "genuinely
     * not accepted" from "the ingest call itself failed" (e.g. to avoid bouncing a recipient over a
     * transient network error). */
    public async checkDomain(domain: string): Promise<boolean> {
        const res: Response = await fetch(`${this.baseUrl}/domain?name=${encodeURIComponent(domain)}`, {
            headers: this.authHeader(),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 200) {
            return true;
        }
        if (res.status === 404) {
            return false;
        }
        throw new Error(`Unexpected status ${res.status} checking domain '${domain}'`);
    }

    /** `GET /internal/mta/resolve?rcpt=<address>` - `true` if `address` resolves to a mailbox or
     * distribution list. Same failure semantics as `checkDomain()`. */
    public async resolveRecipient(address: string): Promise<boolean> {
        const res: Response = await fetch(`${this.baseUrl}/resolve?rcpt=${encodeURIComponent(address)}`, {
            headers: this.authHeader(),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 200) {
            return true;
        }
        if (res.status === 404) {
            return false;
        }
        throw new Error(`Unexpected status ${res.status} resolving recipient '${address}'`);
    }

    /** `POST /internal/mta/deliver` - hands off one accepted SES message's raw MIME plus its envelope.
     * Throws unless the response is `202` (accepted for async processing - see
     * `BaseMailIngestRoute.deliver()`'s own doc comment), so the caller (`ingestHandler`) can decide
     * whether the Lambda invocation itself should be treated as failed/retried. */
    public async deliver(envelopeFrom: string, envelopeTo: string[], raw: Buffer): Promise<void> {
        const res: Response = await fetch(`${this.baseUrl}/deliver`, {
            method: "POST",
            headers: {
                ...this.authHeader(),
                "Content-Type": "message/rfc822",
                "X-Envelope-From": encodeEnvelopeAddress(envelopeFrom),
                "X-Envelope-To": envelopeTo.map(encodeEnvelopeAddress).join(","),
            },
            // Node's fetch (undici) accepts a `Buffer` body at runtime - this project's `BodyInit` typing
            // just doesn't model that, hence the cast.
            body: raw as unknown as BodyInit,
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status !== 202) {
            const body: string = await res.text().catch(() => "");
            throw new Error(`Unexpected status ${res.status} delivering message: ${body}`);
        }
    }
}
