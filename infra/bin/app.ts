#!/usr/bin/env node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { App } from "aws-cdk-lib";
import { SesBridgeStack } from "../lib/ses-bridge-stack.js";

const app: App = new App();

// One stack per mail domain - see SesBridgeStackProps' own doc comment for why. Values come from the
// environment rather than being hardcoded here so `cdk synth` in CI (see .github/workflows/ci.yml, the
// test-cdk-synth job) can run with harmless placeholder values and never needs real AWS credentials or
// a real domain/secret to catch an infra-code error.
const subnetIds: string[] = (process.env.SES_BRIDGE_SUBNET_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
const availabilityZones: string[] = (process.env.SES_BRIDGE_AVAILABILITY_ZONES ?? "")
    .split(",")
    .map((zone) => zone.trim())
    .filter((zone) => zone.length > 0);

new SesBridgeStack(app, "SesBridgeStack", {
    domainName: process.env.SES_BRIDGE_DOMAIN_NAME ?? "example.com",
    mtaIngestBaseUrl: process.env.MTA_INGEST_BASE_URL ?? "https://mail.example.com/internal/mta",
    mtaIngestSecret: process.env.MTA_INGEST_SECRET ?? "ChangeMeIngestSecret",
    // Set both to reach a server whose /internal/mta isn't public - e.g. one deployed by the RapidMX
    // server's own CloudFormation template, where it is an internal load balancer in that VPC.
    vpcId: process.env.SES_BRIDGE_VPC_ID,
    subnetIds: subnetIds.length > 0 ? subnetIds : undefined,
    availabilityZones: availabilityZones.length > 0 ? availabilityZones : undefined,
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
});
