///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// This is the only entry point `@rapidmx/server` (or any other consumer) imports from - it exposes just
// the outbound `MailTransport` implementation. `src/lambda/`'s ingestHandler is deployment code, invoked
// directly by AWS Lambda via the CDK stack in `infra/`, never imported by an application.
export * from "./transport/SesMailTransport.js";
