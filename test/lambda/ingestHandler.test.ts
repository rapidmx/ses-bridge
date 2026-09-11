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

// `mockImplementation` here must be a real `function`, not an arrow function - every one of these is
// invoked with `new` by the code under test, and arrow functions can never be constructors.
const mockS3Send = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
    S3Client: vi.fn().mockImplementation(function () {
        return { send: mockS3Send };
    }),
    GetObjectCommand: vi.fn().mockImplementation(function (input: any) {
        return { input };
    }),
}));

const mockSesSend = vi.fn();
vi.mock("@aws-sdk/client-ses", () => ({
    SESClient: vi.fn().mockImplementation(function () {
        return { send: mockSesSend };
    }),
    SendBounceCommand: vi.fn().mockImplementation(function (input: any) {
        return { input };
    }),
}));

const mockResolveRecipient = vi.fn();
const mockDeliver = vi.fn();
vi.mock("../../src/lambda/MtaIngestClient.js", () => ({
    MtaIngestClient: vi.fn().mockImplementation(function () {
        return { resolveRecipient: mockResolveRecipient, deliver: mockDeliver };
    }),
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
