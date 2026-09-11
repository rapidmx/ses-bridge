# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial scaffold: SesMailTransport (a MailTransport implementation for outbound mail via AWS SES), an ingestHandler Lambda translating SES receipt events into the same /internal/mta/resolve + /internal/mta/deliver calls postfix-bridge makes, and a CDK app provisioning the S3 bucket/receipt rule/Lambda/IAM role this needs
