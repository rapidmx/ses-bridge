///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { MtaIngestClient } from "../../src/lambda/MtaIngestClient.js";

describe("MtaIngestClient Tests", () => {
    const client = new MtaIngestClient("http://server:3000/internal/mta", "s3cr3t");

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function mockFetch(status: number, body: string = ""): void {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                status,
                text: vi.fn().mockResolvedValue(body),
            }),
        );
    }

    describe("checkDomain()", () => {
        it("Returns true on 200, hitting /domain with the bearer secret.", async () => {
            mockFetch(200);
            const result = await client.checkDomain("example.com");
            expect(result).toBe(true);
            expect(fetch).toHaveBeenCalledWith(
                "http://server:3000/internal/mta/domain?name=example.com",
                expect.objectContaining({ headers: { Authorization: "Bearer s3cr3t" } }),
            );
        });

        it("Returns false on 404.", async () => {
            mockFetch(404);
            expect(await client.checkDomain("nobody.com")).toBe(false);
        });

        it("Throws on any other status.", async () => {
            mockFetch(500);
            await expect(client.checkDomain("example.com")).rejects.toThrow(/unexpected status 500/i);
        });

        it("URL-encodes the domain name.", async () => {
            mockFetch(200);
            await client.checkDomain("exämple.com");
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining(encodeURIComponent("exämple.com")),
                expect.anything(),
            );
        });
    });

    describe("resolveRecipient()", () => {
        it("Returns true on 200.", async () => {
            mockFetch(200);
            expect(await client.resolveRecipient("a@example.com")).toBe(true);
            expect(fetch).toHaveBeenCalledWith(
                "http://server:3000/internal/mta/resolve?rcpt=a%40example.com",
                expect.anything(),
            );
        });

        it("Returns false on 404.", async () => {
            mockFetch(404);
            expect(await client.resolveRecipient("nobody@example.com")).toBe(false);
        });

        it("Throws on any other status.", async () => {
            mockFetch(503);
            await expect(client.resolveRecipient("a@example.com")).rejects.toThrow(/unexpected status 503/i);
        });
    });

    describe("deliver()", () => {
        it("Resolves on 202, sending the envelope as headers and the raw body unmodified.", async () => {
            mockFetch(202);
            const raw = Buffer.from("From: a@example.com\r\n\r\nHi\r\n");

            await client.deliver("a@example.com", ["b@example.com", "c@example.com"], raw);

            expect(fetch).toHaveBeenCalledWith(
                "http://server:3000/internal/mta/deliver",
                expect.objectContaining({
                    method: "POST",
                    headers: expect.objectContaining({
                        Authorization: "Bearer s3cr3t",
                        "Content-Type": "message/rfc822",
                        "X-Envelope-From": "a@example.com",
                        "X-Envelope-To": "b@example.com,c@example.com",
                    }),
                    body: raw,
                }),
            );
        });

        it("Throws with the response body on any status other than 202.", async () => {
            mockFetch(400, "bad request");
            await expect(client.deliver("a@example.com", ["b@example.com"], Buffer.from("x"))).rejects.toThrow(
                /unexpected status 400.*bad request/is,
            );
        });

        it("Throws without a body detail if reading the response text itself fails.", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue({
                    status: 500,
                    text: vi.fn().mockRejectedValue(new Error("stream closed")),
                }),
            );
            await expect(client.deliver("a@example.com", ["b@example.com"], Buffer.from("x"))).rejects.toThrow(
                /unexpected status 500/i,
            );
        });
    });
});
