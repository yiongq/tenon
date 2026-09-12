# Security Policy

Tenon runs model-driven code on the user's machine and, in later phases, in multi-tenant cloud sandboxes. Security reports are taken seriously.

## Reporting a vulnerability

Do not open a public issue. Email the maintainer (see the GitHub profile of the repository owner) with:

- a description of the issue and its impact
- steps to reproduce or a proof of concept
- the affected version or commit

You will get an acknowledgement within 72 hours. Please allow a reasonable time for a fix before public disclosure.

## Scope

In scope: the desktop app, `packages/kernel`, `packages/contracts`, the permission engine, sandbox integration, MCP host, MCP App rendering, plugin installation.

Out of scope: third-party MCP servers and plugins you install; the model providers' services.

## Design principles

- Every privileged capability lives in the main process; the renderer has no Node access.
- Every subprocess runs through the sandbox wrapper; network is off by default.
- MCP tool annotations and results are untrusted input and never weaken a permission check.
- Permission decisions are auditable: policy and the user may loosen, machines may only tighten.
