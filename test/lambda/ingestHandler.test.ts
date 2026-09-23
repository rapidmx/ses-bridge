///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for ingestHandler - `@aws-sdk/client-s3`/`@aws-sdk/client-ses` and this repo's own
// MtaIngestClient are all mocked, so no real AWS/network call occurs. The module under test reads its
// config (MTA_INGEST_BASE_URL/_SECRET, SES_BUCKET_NAME/_OBJECT_KEY_PREFIX) once, eagerly, at import time
// (see its own doc comment for why) - so those env vars are set, and the module dynamically imported,
// inside beforeAll(), after the mocks above are in place but before anything under test runs.
import type { SESEvent } from "aws-lambda";

// `mockImplementation`/`mockS3ClientCtor` etc. here must be real `function`s, not arrow functions - every
// one of these is invoked with `new` by the code under test, and arrow functions can never be constructors.
// The constructor mocks are declared as outer `const`s (not inline inside the `vi.mock()` factory) and
// captured by closure, so they stay the SAME reference across a `vi.resetModules()` + re-import (several
// tests below need that, to assert what options the code under test constructed these clients with after
// re-importing it with different env vars) - mirroring postfix-bridge's own `test/index.test.ts` pattern.
const mockS3Send = vi.fn();
const mockS3ClientCtor = vi.fn(function (this: { send: typeof mockS3Send }) {
    this.send = mockS3Send;
});
vi.mock("@aws-sdk/client-s3", () => ({
    S3Client: mockS3ClientCtor,
    GetObjectCommand: vi.fn().mockImplementation(function (input: any) {
        return { input };
    }),
}));

const mockSesSend = vi.fn();
const mockSesClientCtor = vi.fn(function (this: { send: typeof mockSesSend }) {
    this.send = mockSesSend;
});
vi.mock("@aws-sdk/client-ses", () => ({
    SESClient: mockSesClientCtor,
    SendBounceCommand: vi.fn().mockImplementation(function (input: any) {
        return { input };
    }),
}));

const mockResolveRecipient = vi.fn();
const mockDeliver = vi.fn();
const mockMtaIngestClientCtor = vi.fn(function (this: Record<string, unknown>) {
    this.resolveRecipient = mockResolveRecipient;
    this.deliver = mockDeliver;
});
vi.mock("../../src/lambda/MtaIngestClient.js", () => ({
    MtaIngestClient: mockMtaIngestClientCtor,
    DEFAULT_MTA_INGEST_TIMEOUT_MS: 10_000,
}));

let handler: (event: SESEvent) => Promise<{ disposition: "CONTINUE" | "STOP_RULE_SET" }>;

beforeAll(async () => {
    process.env.MTA_INGEST_BASE_URL = "http://server:3000/internal/mta";
    process.env.MTA_INGEST_SECRET = "s3cr3t";
    process.env.SES_BUCKET_NAME = "test-bucket";
    process.env.SES_OBJECT_KEY_PREFIX = "inbound/";
    ({ handler } = await import("../../src/lambda/ingestHandler.js"));
});

function s3GetObjectResponse(text: string): { Body: { transformToByteArray: () => Promise<Uint8Array> } } {
    return { Body: { transformToByteArray: vi.fn().mockResolvedValue(new TextEncoder().encode(text)) } };
}

function makeEvent(recipients: string[], overrides: { source?: string; messageId?: string } = {}): SESEvent {
    return {
        Records: [
            {
                eventSource: "aws:ses",
                eventVersion: "1.0",
                ses: {
                    mail: {
                        timestamp: "2026-09-10T00:00:00.000Z",
                        source: overrides.source ?? "sender@external.com",
                        messageId: overrides.messageId ?? "msg-1",
                        destination: recipients,
                        headersTruncated: false,
                        headers: [],
                        commonHeaders: { returnPath: overrides.source ?? "sender@external.com", date: "", messageId: overrides.messageId ?? "msg-1" },
                    },
                    receipt: {
                        timestamp: "2026-09-10T00:00:00.000Z",
                        processingTimeMillis: 10,
                        recipients,
                        spamVerdict: { status: "PASS" },
                        virusVerdict: { status: "PASS" },
                        spfVerdict: { status: "PASS" },
                        dkimVerdict: { status: "PASS" },
                        dmarcVerdict: { status: "PASS" },
                        action: { type: "Lambda", functionArn: "arn:aws:lambda:...", invocationType: "RequestResponse" },
                    },
                },
            },
        ],
    };
}

describe("ingestHandler Tests", () => {
    beforeEach(() => {
        mockS3Send.mockReset();
        mockSesSend.mockReset();
        mockResolveRecipient.mockReset();
        mockDeliver.mockReset();
        mockSesSend.mockResolvedValue({});
        mockDeliver.mockResolvedValue(undefined);
    });

    it("Delivers to every recipient that resolves, fetching the raw message from the derived S3 key.", async () => {
        mockResolveRecipient.mockResolvedValue(true);
        mockS3Send.mockResolvedValue(s3GetObjectResponse("From: sender@external.com\r\n\r\nHi"));

        const result = await handler(makeEvent(["a@example.com", "b@example.com"], { messageId: "msg-42" }));

        expect(mockS3Send).toHaveBeenCalledWith(
            expect.objectContaining({ input: { Bucket: "test-bucket", Key: "inbound/msg-42" } }),
        );
        expect(mockDeliver).toHaveBeenCalledWith(
            "sender@external.com",
            ["a@example.com", "b@example.com"],
            Buffer.from("From: sender@external.com\r\n\r\nHi"),
        );
        expect(mockSesSend).not.toHaveBeenCalled();
        expect(result).toEqual({ disposition: "CONTINUE" });
    });

    it("Bounces only the recipients that don't resolve, and still delivers to the ones that do.", async () => {
        mockResolveRecipient.mockImplementation(async (rcpt: string) => rcpt === "known@example.com");
        mockS3Send.mockResolvedValue(s3GetObjectResponse("raw"));

        const result = await handler(makeEvent(["known@example.com", "unknown@example.com"]));

        expect(mockSesSend).toHaveBeenCalledWith(
            expect.objectContaining({
                input: expect.objectContaining({
                    OriginalMessageId: "msg-1",
                    BounceSender: "mailer-daemon@example.com",
                    BouncedRecipientInfoList: [{ Recipient: "unknown@example.com", BounceType: "DoesNotExist" }],
                }),
            }),
        );
        expect(mockDeliver).toHaveBeenCalledWith("sender@external.com", ["known@example.com"], expect.any(Buffer));
        expect(result).toEqual({ disposition: "CONTINUE" });
    });

    it("Bounces every recipient and never fetches/delivers when none resolve.", async () => {
        mockResolveRecipient.mockResolvedValue(false);

        const result = await handler(makeEvent(["a@example.com", "b@example.com"]));

        expect(mockSesSend).toHaveBeenCalledTimes(1);
        expect(mockS3Send).not.toHaveBeenCalled();
        expect(mockDeliver).not.toHaveBeenCalled();
        expect(result).toEqual({ disposition: "STOP_RULE_SET" });
    });

    it("Sends no bounce at all when every recipient resolves.", async () => {
        mockResolveRecipient.mockResolvedValue(true);
        mockS3Send.mockResolvedValue(s3GetObjectResponse("raw"));

        await handler(makeEvent(["a@example.com"]));

        expect(mockSesSend).not.toHaveBeenCalled();
    });

    it("Processes every record in a multi-record event independently.", async () => {
        mockResolveRecipient.mockResolvedValue(true);
        mockS3Send.mockResolvedValue(s3GetObjectResponse("raw"));

        const event = makeEvent(["a@example.com"], { messageId: "msg-a" });
        event.Records.push(makeEvent(["b@example.com"], { messageId: "msg-b" }).Records[0]);

        await handler(event);

        expect(mockDeliver).toHaveBeenCalledTimes(2);
        expect(mockS3Send).toHaveBeenCalledWith(expect.objectContaining({ input: { Bucket: "test-bucket", Key: "inbound/msg-a" } }));
        expect(mockS3Send).toHaveBeenCalledWith(expect.objectContaining({ input: { Bucket: "test-bucket", Key: "inbound/msg-b" } }));
    });

    it("Isolates a failing record: its error doesn't stop other records in the same event or fail the invocation.", async () => {
        // A synchronous SES Lambda receipt action has no SQS-style per-item failure reporting - if the
        // whole handler() rejected here, SES would retry the ENTIRE invocation, redelivering the record
        // that already succeeded below a second time. Verifies that no longer happens: one record's
        // deliver() throwing is caught and logged, while the other record in the same event still
        // completes and the invocation as a whole resolves normally.
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        mockResolveRecipient.mockResolvedValue(true);
        mockS3Send.mockResolvedValue(s3GetObjectResponse("raw"));
        mockDeliver.mockImplementation(async (_from: string, recipients: string[]) => {
            if (recipients.includes("fails@example.com")) {
                throw new Error("restapi unavailable");
            }
        });

        const event = makeEvent(["fails@example.com"], { messageId: "msg-fail" });
        event.Records.push(makeEvent(["ok@example.com"], { messageId: "msg-ok" }).Records[0]);

        const result = await handler(event);

        expect(mockDeliver).toHaveBeenCalledTimes(2);
        expect(mockDeliver).toHaveBeenCalledWith(expect.any(String), ["ok@example.com"], expect.any(Buffer));
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("msg-fail"), expect.any(Error));
        // The record that succeeded is still reflected in the result - one failure doesn't drag the whole
        // invocation's outcome down with it.
        expect(result).toEqual({ disposition: "CONTINUE" });

        consoleErrorSpy.mockRestore();
    });

    it("Resolves every recipient of a record concurrently, in the order the receipt gave them, regardless of which settles first.", async () => {
        // Deliberately resolves out of call order (the second recipient resolves before the first) - if
        // resolution were still sequential/order-dependent, resolved/unresolved would come out scrambled.
        mockResolveRecipient.mockImplementation(
            (rcpt: string) =>
                new Promise<boolean>((resolve) => {
                    const delayMs = rcpt === "slow@example.com" ? 10 : 0;
                    setTimeout(() => resolve(rcpt !== "unknown@example.com"), delayMs);
                }),
        );
        mockS3Send.mockResolvedValue(s3GetObjectResponse("raw"));

        const result = await handler(makeEvent(["slow@example.com", "unknown@example.com", "fast@example.com"]));

        expect(mockDeliver).toHaveBeenCalledWith(
            "sender@external.com",
            ["slow@example.com", "fast@example.com"],
            expect.any(Buffer),
        );
        expect(mockSesSend).toHaveBeenCalledWith(
            expect.objectContaining({
                input: expect.objectContaining({
                    BouncedRecipientInfoList: [{ Recipient: "unknown@example.com", BounceType: "DoesNotExist" }],
                }),
            }),
        );
        expect(result).toEqual({ disposition: "CONTINUE" });
    });

    it("Resolves the other recipients of a record even when one resolveRecipient() call throws - no longer all-or-nothing.", async () => {
        // Regression: Promise.all() (the previous implementation) is all-or-nothing - one recipient hitting
        // a transient error used to reject the whole array and silently discard every OTHER recipient's
        // already-computed result too, dropping the entire record (no delivery, no bounce, just a
        // console.error) over a single recipient's transient failure. Promise.allSettled() fixes that: the
        // failing recipient is bounced (treated the same as an explicit "doesn't resolve"), while its
        // neighbor in the same record still gets delivered normally.
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        mockResolveRecipient.mockImplementation(async (rcpt: string) => {
            if (rcpt === "flaky@example.com") {
                throw new Error("upstream 500");
            }
            return true;
        });
        mockS3Send.mockResolvedValue(s3GetObjectResponse("raw"));

        const result = await handler(makeEvent(["flaky@example.com", "ok@example.com"]));

        expect(mockDeliver).toHaveBeenCalledWith("sender@external.com", ["ok@example.com"], expect.any(Buffer));
        expect(mockSesSend).toHaveBeenCalledWith(
            expect.objectContaining({
                input: expect.objectContaining({
                    BouncedRecipientInfoList: [{ Recipient: "flaky@example.com", BounceType: "DoesNotExist" }],
                }),
            }),
        );
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("flaky@example.com"), expect.any(Error));
        expect(result).toEqual({ disposition: "CONTINUE" });

        consoleErrorSpy.mockRestore();
    });

    it("Derives the DSN bounce's ReportingMta from the recipient domain and ArrivalDate from the message's own SES-recorded arrival time.", async () => {
        mockResolveRecipient.mockResolvedValue(false);

        await handler(makeEvent(["unknown@example.com"]));

        expect(mockSesSend).toHaveBeenCalledWith(
            expect.objectContaining({
                input: expect.objectContaining({
                    MessageDsn: expect.objectContaining({
                        ReportingMta: "dns; example.com",
                        ArrivalDate: new Date("2026-09-10T00:00:00.000Z"),
                    }),
                }),
            }),
        );
    });

    it("Falls back to mailer-daemon@localhost when the bounced recipient address has no domain.", async () => {
        mockResolveRecipient.mockResolvedValue(false);

        await handler(makeEvent(["not-an-email-address"]));

        expect(mockSesSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: expect.objectContaining({ BounceSender: "mailer-daemon@localhost" }) }),
        );
    });

    it("Uses an empty S3 object key prefix when SES_OBJECT_KEY_PREFIX is unset.", async () => {
        const originalPrefix = process.env.SES_OBJECT_KEY_PREFIX;
        delete process.env.SES_OBJECT_KEY_PREFIX;
        vi.resetModules();
        const { handler: handlerWithNoPrefix } = await import("../../src/lambda/ingestHandler.js");

        mockResolveRecipient.mockResolvedValue(true);
        mockS3Send.mockResolvedValue(s3GetObjectResponse("raw"));

        await handlerWithNoPrefix(makeEvent(["a@example.com"], { messageId: "msg-42" }));

        expect(mockS3Send).toHaveBeenCalledWith(expect.objectContaining({ input: { Bucket: "test-bucket", Key: "msg-42" } }));

        process.env.SES_OBJECT_KEY_PREFIX = originalPrefix;
        vi.resetModules();
        ({ handler } = await import("../../src/lambda/ingestHandler.js"));
    });

    it.each(["not-a-number", "", "0", "-1"])(
        "throws at import time if MTA_INGEST_TIMEOUT_MS is set to an invalid value (%j) - requirePositiveNumber's own guard.",
        async (badValue) => {
            process.env.MTA_INGEST_TIMEOUT_MS = badValue;
            vi.resetModules();

            await expect(import("../../src/lambda/ingestHandler.js")).rejects.toThrow(
                "MTA_INGEST_TIMEOUT_MS must be a positive number if set",
            );

            delete process.env.MTA_INGEST_TIMEOUT_MS;
            vi.resetModules();
            ({ handler } = await import("../../src/lambda/ingestHandler.js"));
        },
    );

    it("Uses MtaIngestClient's own default timeout, and passes it to the S3/SES request handlers too, when MTA_INGEST_TIMEOUT_MS is unset.", async () => {
        delete process.env.MTA_INGEST_TIMEOUT_MS;
        vi.resetModules();

        await import("../../src/lambda/ingestHandler.js");

        expect(mockMtaIngestClientCtor).toHaveBeenCalledWith("http://server:3000/internal/mta", "s3cr3t", 10_000);
        const expectedRequestHandler = { connectionTimeout: 10_000, requestTimeout: 10_000, throwOnRequestTimeout: true };
        expect(mockS3ClientCtor).toHaveBeenCalledWith(expect.objectContaining({ requestHandler: expectedRequestHandler }));
        expect(mockSesClientCtor).toHaveBeenCalledWith(expect.objectContaining({ requestHandler: expectedRequestHandler }));

        vi.resetModules();
        ({ handler } = await import("../../src/lambda/ingestHandler.js"));
    });

    it("Plumbs a custom MTA_INGEST_TIMEOUT_MS through to MtaIngestClient and the S3/SES request handlers.", async () => {
        process.env.MTA_INGEST_TIMEOUT_MS = "5000";
        vi.resetModules();

        await import("../../src/lambda/ingestHandler.js");

        expect(mockMtaIngestClientCtor).toHaveBeenCalledWith("http://server:3000/internal/mta", "s3cr3t", 5000);
        const expectedRequestHandler = { connectionTimeout: 5000, requestTimeout: 5000, throwOnRequestTimeout: true };
        expect(mockS3ClientCtor).toHaveBeenCalledWith(expect.objectContaining({ requestHandler: expectedRequestHandler }));
        expect(mockSesClientCtor).toHaveBeenCalledWith(expect.objectContaining({ requestHandler: expectedRequestHandler }));

        delete process.env.MTA_INGEST_TIMEOUT_MS;
        vi.resetModules();
        ({ handler } = await import("../../src/lambda/ingestHandler.js"));
    });

    it("throws at import time if a required env var is missing (requireEnv's own guard).", async () => {
        // Run last and restore `handler` to a freshly-imported, fully-configured module afterward -
        // every other test in this file shares the one `handler` captured by the outer beforeAll().
        const originalBucketName = process.env.SES_BUCKET_NAME;
        delete process.env.SES_BUCKET_NAME;
        vi.resetModules();

        await expect(import("../../src/lambda/ingestHandler.js")).rejects.toThrow("SES_BUCKET_NAME must be set");

        process.env.SES_BUCKET_NAME = originalBucketName;
        vi.resetModules();
        ({ handler } = await import("../../src/lambda/ingestHandler.js"));
    });
});
