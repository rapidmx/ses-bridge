///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import * as http from "node:http";
import * as net from "node:net";
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
        it("Resolves on 202, sending the envelope as (percent-encoded) headers and the raw body unmodified.", async () => {
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
                        "X-Envelope-From": encodeURIComponent("a@example.com"),
                        "X-Envelope-To": `${encodeURIComponent("b@example.com")},${encodeURIComponent("c@example.com")}`,
                    }),
                    body: raw,
                    signal: expect.any(AbortSignal),
                }),
            );
        });

        it("Percent-encodes a comma inside a quoted local part so it can't be split into an extra recipient.", async () => {
            // SES's own envelope validation only needs to satisfy SMTP grammar - a quoted local part
            // containing a literal comma (RFC 5321 allows it) can legitimately reach `envelopeTo` here.
            // Joining recipients with a bare "," would then be ambiguous to split back apart.
            mockFetch(202);
            const tricky = '"a,b"@example.com';

            await client.deliver("sender@example.com", [tricky, "c@example.com"], Buffer.from("x"));

            const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Record<string, string>;
            const segments = headers["X-Envelope-To"].split(",");
            // Exactly one segment per recipient - not three, which is what a naive split of the unescaped
            // header value would have produced.
            expect(segments).toHaveLength(2);
            expect(decodeURIComponent(segments[0])).toBe(tricky);
            expect(decodeURIComponent(segments[1])).toBe("c@example.com");
        });

        it("Percent-encodes a non-ASCII (SMTPUTF8) local part so it survives as a valid HTTP header value.", async () => {
            mockFetch(202);
            const intl = "jörg@example.com";

            await client.deliver(intl, [intl], Buffer.from("x"));

            const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Record<string, string>;
            expect(headers["X-Envelope-From"]).toBe(encodeURIComponent(intl));
            expect(/^[\x21-\x7e]*$/.test(headers["X-Envelope-From"])).toBe(true);
            expect(decodeURIComponent(headers["X-Envelope-To"])).toBe(intl);
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

    describe("upstream timeout", () => {
        // Real HTTP against a server that accepts the connection but never responds - a mocked fetch can't
        // show whether an AbortSignal.timeout() actually cuts off a real stalled request. ingestHandler
        // runs inside a Lambda with its own hard function timeout, but without a client-side timeout here a
        // single hung upstream call would silently consume that entire remaining budget instead of failing
        // fast (see MtaIngestClient's own `timeoutMs` doc comment).
        function hangingServer(): Promise<{ server: http.Server; port: number }> {
            return new Promise((resolve) => {
                const server = http.createServer(() => {
                    // Deliberately never calls res.end() (or even res.writeHead()) - simulates an upstream
                    // that accepted the TCP connection but never answers.
                });
                server.listen(0, "127.0.0.1", () =>
                    resolve({ server, port: (server.address() as net.AddressInfo).port }),
                );
            });
        }

        async function closeHangingServer(server: http.Server): Promise<void> {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }

        it("checkDomain() aborts and rejects promptly instead of hanging forever on a stalled upstream.", async () => {
            const { server, port } = await hangingServer();
            try {
                const impatientClient = new MtaIngestClient(`http://127.0.0.1:${port}/internal/mta`, "s3cr3t", 50);
                const start = Date.now();
                await expect(impatientClient.checkDomain("example.com")).rejects.toThrow();
                expect(Date.now() - start).toBeLessThan(2000);
            } finally {
                await closeHangingServer(server);
            }
        });

        it("resolveRecipient() aborts and rejects promptly instead of hanging forever on a stalled upstream.", async () => {
            const { server, port } = await hangingServer();
            try {
                const impatientClient = new MtaIngestClient(`http://127.0.0.1:${port}/internal/mta`, "s3cr3t", 50);
                const start = Date.now();
                await expect(impatientClient.resolveRecipient("a@example.com")).rejects.toThrow();
                expect(Date.now() - start).toBeLessThan(2000);
            } finally {
                await closeHangingServer(server);
            }
        });

        it("deliver() aborts and rejects promptly instead of hanging forever on a stalled upstream.", async () => {
            const { server, port } = await hangingServer();
            try {
                const impatientClient = new MtaIngestClient(`http://127.0.0.1:${port}/internal/mta`, "s3cr3t", 50);
                const start = Date.now();
                await expect(
                    impatientClient.deliver("a@example.com", ["b@example.com"], Buffer.from("x")),
                ).rejects.toThrow();
                expect(Date.now() - start).toBeLessThan(2000);
            } finally {
                await closeHangingServer(server);
            }
        });

        it("Uses the default timeout when none is given to the constructor.", async () => {
            const noTimeoutArgClient = new MtaIngestClient("http://server:3000/internal/mta", "s3cr3t");
            mockFetch(200);

            await noTimeoutArgClient.checkDomain("example.com");

            const signal = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].signal as AbortSignal;
            expect(signal).toBeInstanceOf(AbortSignal);
            expect(signal.aborted).toBe(false);
        });
    });
});
