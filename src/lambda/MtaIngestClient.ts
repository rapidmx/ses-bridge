///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

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
                "X-Envelope-From": envelopeFrom,
                "X-Envelope-To": envelopeTo.join(","),
            },
            // Node's fetch (undici) accepts a `Buffer` body at runtime - this project's `BodyInit` typing
            // just doesn't model that, hence the cast.
            body: raw as unknown as BodyInit,
        });
        if (res.status !== 202) {
            const body: string = await res.text().catch(() => "");
            throw new Error(`Unexpected status ${res.status} delivering message: ${body}`);
        }
    }
}
