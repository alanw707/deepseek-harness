# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

[Inferred from the explicit feature request] A local developer uses an authenticated browser on the same machine to move bounded project work from request to reviewed application.

## Product Purpose

Software Factory lets a developer register a project, ask Pi, Codex, or OpenClaw to perform one bounded task in a private snapshot, inspect the exact staged changes, and decide whether to apply them to the original project.

## Positioning

The product separates executor work from human approval: an executor writes only to a private snapshot, while the developer controls start, exact change review, and digest-bound application.

## Operating Context

The route is loopback-only and fills the existing DSH shell's center column. The developer uses the local Web profile, project history, task status, bounded output, before-and-after views, and explicit apply action.

## Capabilities and Constraints

Chat remains the default landing surface. Software Factory is an additive route with the sequence New task, Review & start, Review changes, and Apply. Browser sessions require the supported DSH authentication and a dashboard session with CSRF protection. Original files remain unchanged until exact reviewed changes are applied.

## Brand Commitments

The DSH name, original Chat experience, authenticated Web profile, and local-only operating model remain recognizable and intact.

## Evidence on Hand

The Host API implementation lives in `src/index.ts`; the shell route lives in `src/client/TaskDashboardView.tsx`; focused coverage lives in `tests/task-dashboard.spec.ts` and `tests/client-apply.client.spec.tsx`. The built-profile integration test is `apps/cli/tests/built-bin.e2e.ts`; the opt-in real-model flow is `apps/cli/tests/command-center-real-flow.e2e.ts`.

## Product Principles

- Make the approval boundary visible before execution details.
- Keep executor work private until a human reviews the exact result.
- Preserve the original DSH Chat product and durable data.
- Explain every task state in plain language.
