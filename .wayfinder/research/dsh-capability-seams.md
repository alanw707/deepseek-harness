# DeepSeek Harness capability and extension-seam inventory

- **Research ticket:** [#7 — Inventory DeepSeek Harness capabilities and extension seams](https://github.com/alanw707/deepseek-harness/issues/7)
- **Researched commit:** [`cd5ef8148158c3a752a658978873241fdf8e2bbc`](https://github.com/alanw707/deepseek-harness/tree/cd5ef8148158c3a752a658978873241fdf8e2bbc)
- **Scope:** current source, generated catalogs, package manifests and non-archived implemented Agent Notes at that commit. Archived notes are not used as current authority.

## Reading convention

- **Fact** describes repository state at the researched commit.
- **Recommendation** proposes how an enterprise software-factory layer should reuse or extend that state. Recommendations are not claims that the behavior exists.
- Source shortcuts resolve to commit-pinned repository paths in the [source index](#source-index).

## Executive findings

1. **Fact — Harness already has a plugin microkernel, not a monolithic agent.** Cordis plugins contribute services, typed events and reversible effects; profiles and bundles compose the runtime; `dsh-agent-loop` is the only shipped concrete loop but is replaceable through `ctx.agents`. New behavior is expected to mount beside the loop. [S1] [S5] [S6]
2. **Fact — The strongest reusable factory foundation is the append-only Session log.** It is the source of model history, durable lifecycle facts, replay, fork, persistence, projections, search, telemetry and UI reconstruction. Model-visible input must be durably reconstructable from the log and pinned referenced objects. [S1] [S7] [S25]
3. **Fact — Specification primitives exist, but not a software-specification domain.** Goals provide one revisioned objective and lifecycle per Session; plan mode provides soft human-reviewed planning guidance; todos provide a whole-list three-state task projection. None represents versioned requirements, acceptance criteria, dependencies, ownership or requirement-to-evidence traceability. [S9] [S10] [S11]
4. **Fact — Orchestration foundations are substantial.** Named subagent providers support one-shot and continuable children; workflows provide model-authored fan-out scripts via a complete Service Definition / Service Provider / Consumer seam; jobs provide owner-fenced background work; schedules provide durable Session-local reminders; authenticated webhooks can create ordinary Workspace Sessions. [S12] [S13] [S14] [S15] [S16]
5. **Fact — Current identity is not enterprise identity.** The identity package exposes only an anonymous UUID per Harness home for telemetry, feedback and DeepSeek request correlation. Session, Agent, Workspace, tool-call, goal and job ids are opaque domain identifiers, not authenticated people, service accounts, groups or tenant principals. [S23] [S25]
6. **Fact — Permission controls are action-local and safety-oriented.** Tool policy uses `allow`/`deny`/`ask`, monotonic guards and one-shot fail-closed approvals; permission presets bundle sandbox and approval settings; sandboxing governs filesystem effects. There is no persistent grant store, role/resource policy model or enterprise authorization decision service. [S17] [S18] [S19] [S20]
7. **Fact — Evidence exists as execution history, not as certified factory evidence.** Session logs preserve prompts, model output, tool calls/results, approvals, retries, goals, plans, todos and workflow display records; query and projections expose those facts. No first-class requirement, build, test, artifact, review, attestation or release-evidence aggregate appears in the generated service or Session-event catalogs. [S2] [S4] [S27]
8. **Recommendation — Add factory behavior as capability families and durable event domains.** Reuse Session events for Session-scoped facts, `ctx.storageDomain` for independent cross-Session entities, projections/query for reads, tools/commands/UI/webhooks as Consumers, and existing workflow/subagent/job services for execution. Do not add specification state, policy, scheduling, evidence evaluation or factory-run state to `agent-loop`.

## Capability-to-factory-lifecycle matrix

| Factory lifecycle stage | Existing facts | Reusable foundation | Missing role or semantic | Recommendation |
|---|---|---|---|---|
| Intake / trigger | Human prompts and commands enter an Agent; authenticated webhook adapters dispatch trusted rules that may create a Workspace-backed root Session. Webhook dispatch is fire-and-forget. [S16] [S22] [S25] | `ctx.commands`, `ctx.webhookRuntime`, Session creation, Workspace registry | Durable intake item, deduplication, retry, queue, requester principal and delivery/completion status | Add a durable intake/work-item seam; let webhook and UI adapters be Consumers/providers of intake, not owners of execution state. |
| Specify | A Goal stores one objective, revision, round cap and active/paused/blocked/complete phase; Plan Mode adds reviewed soft guidance; todo stores a minimal whole-list task snapshot. [S9] [S10] [S11] | `ctx.goals`, `ctx.planMode`, `todo/write`, commands, tools, projections | Versioned requirements, acceptance criteria, constraints, relationships, baselines and change approval | Add a specification Service Definition with durable storage/fold provider and model/UI/API Consumers. Link goals to specs instead of widening GoalSnapshot. |
| Compose agent / context | Profiles and bundles compose Host services; presets mount per-Session tools, prompt sections, skills and personas in an Agent scope. Model-visible composition choice is logged. [S1] [S24] [S31] | profile patches, `ctx.agentPresets`, scoped registrations, `ctx.systemPrompt`, `ctx.skills` | Factory-role templates tied to authenticated organization policy and work-item type | Treat factory roles as preset/config data. Keep provider/model routing and shared cross-Session services in the Host plane. |
| Plan / decompose | Plan Mode supports human review; todo tracks pending/in-progress/completed items; Goals can drive bounded sequential continuation. [S9] [S10] [S11] | plan-review `ctx.userQuestions`, todo projection, goal round driver | Durable dependency graph, assignment, estimate, acceptance links and independent plan approval record | Introduce a work-breakdown domain if needed; do not turn todo's intentionally minimal replacement list into a general scheduler. |
| Execute tools | Tool definitions register scoped schemas and canonical output; execution passes through pre-policy, monotonic guards, around-dispatch and post-policy; accepted calls/results are logged. [S20] | `ctx.tools`, shell/fs/subprocess/sandbox seams, code runtime, jobs, spill policy | Organization policy decision using actor/resource/action/context; artifact/result registration | Add guards/Consumers that call a policy seam at `ctx.tools.execute()` and artifact/evidence Consumers after authoritative results commit. |
| Delegate / orchestrate | `ctx.subagents` supports named providers, capability preflight, one-shot runs, continuable children, follow-up, interruption, reporting and durable discovery. `ctx.workflowEngine` runs fan-out scripts through subagents. [S12] [S13] | complete subagent and workflow seams; agent-scoped tools; workflow lifecycle events | Durable resumable workflow execution, saved workflow definitions, queueing and cross-process control | Preserve existing seams; add a durable orchestration provider only when resume/queue requirements exist. Do not encode DAG execution in the loop. |
| Background / timed work | `ctx.jobs` owns process-local, owner-fenced jobs and completion notices; Schedule owns durable live-Session reminders; webhook rules trigger external work. [S14] [S15] [S16] | jobs registry, `schedule/change`, Agent inbox, webhook adapters | Durable cross-process job queue, leases, retries, calendar schedules, cold execution and delivery guarantees | Add a queue/scheduler seam rather than stretching process-local jobs or Session-local reminders. |
| Human decision | Commands execute without model turns; user questions provide structured forms; approvals provide one-shot closed outcomes and durable audit; plan review uses presentation intent. [S17] [S21] [S22] | `ctx.commands`, `ctx.userQuestions`, `ctx.approval`, Web/ACP answerers | Enterprise approver identity, delegation, quorum, expiry, persistent grants and separation of duties | Add principal-aware decision records and authorization provider(s); retain approval as the one-action execution gate. |
| Observe progress | Live `agent/*`, `workflow/*`, `subagent/*`, jobs notifications and Session projections feed clients; workflow tool records rebuild a durable Chat node. [S3] [S12] [S13] [S14] | events, projections, Conversation nodes, Host Remote services | Factory-wide run/status aggregate and service-level progress independent of one live process | Add projection units over durable factory events; use live events only as coordination hints. |
| Verify / collect evidence | Session records preserve tool calls/results and source relationships; Session Query provides exact reads, filters, search, lineage and event traces; feedback captures user judgments. [S25] [S27] [S29] | Session log, `sourceEventSeqs`, query seam, attachments, projections, feedback | Typed evidence claims, artifact digests, test/build provenance, requirement links, attestations and evaluator certificates | Add an evidence seam/domain. Store immutable evidence references and evaluator outcomes; project them into UI/tools. |
| Complete / release | Goals can be marked complete or blocked; a Session turn records completed/blocked/error/max-token/interrupted outcomes. Goal completion is authoritative but has no independent evaluator certificate. [S9] [S25] | goal lifecycle, turn outcomes, session flush/checkpoints | Factory-run completion criteria, release state machine, independent verification and approval policy | Implement completion policy as a Consumer over spec/evidence/run services; write durable completion events outside the loop. |
| Persist / resume / audit | JSONL or SQLite persist the same Session events; checkpoints make model requests, top-level side effects and completed steps durable; projections, search, export, fork and resume derive from logs. [S25] [S26] [S27] | `ctx.sessionPersistence`, checkpoint policy, projection cache, query, export, fork | Stable released schema/migrations and cross-Session factory aggregate retention | Reuse Session persistence for Session-scoped records; use storage-domain or a new backend for factory aggregates. Plan migrations before relying on format v0. |

## Current capability and service inventory

The generated capability graph is the exhaustive service-level authority at the researched commit. It classifies services as core, seam or bundle and lists owners, implementations and direct Consumers. [S2]

### Specification and composition

| Service / event | Current role and user experience | Capability-role status |
|---|---|---|
| `ctx.goals`, `goal/change` | One durable Goal per Session; model tools and `/goal` create/read/update it; optional goal-round driver automatically continues bounded rounds. [S9] | Core domain plus tool/command/driver Consumers; not a general specification seam. |
| `ctx.planMode`, `plan/mode` | `/plan` activates soft guidance; `exit_plan_mode` submits Markdown for human review through user questions. Tools remain available; sandbox and approval enforce separately. [S10] | Core collaboration state combining service, prompt, tool and command roles. |
| `todo/write` | `todo_write` replaces a Session's list of `{content,status}` items; clients may project it. [S11] | Tool-owned durable domain; deliberately no service key or stable item identity. |
| `ctx.agentPresets`, `agent-preset/selected` | Discovers and mounts per-Session `agent.cordis.yml`; preset tools, prompts, skills and persona are isolated to that Agent. [S24] | Core composition service; preset rows are effect-scoped contributions. |
| `ctx.systemPrompt` / `ctx.skills` | Prompt sections and tool schemas assemble per step; skills merge provider catalogs and load bodies through a tool Consumer. [S1] [S2] | Core prompt registry; skills are a complete provider-registry/tool seam. |

### Orchestration and lifecycle

| Service | Current role and constraints | Capability-role status |
|---|---|---|
| `ctx.agents` / `ctx.agentLoop` | Agent registry owns live handles and factory/resume; default loop performs model-call/tool-repeat lifecycle. Extensions depend on Agent/session events, not the concrete loop. [S1] [S5] | Core service plus one replaceable bundle implementation. |
| `ctx.subagents` | Named provider registry with in-process spawn/fork and external ACP/Codex/Claude Code/DSH SDK providers; tool Consumers expose delegation and control. [S13] [S32] | Complete seam: Service Definition, multiple Service Providers, multiple Consumers. |
| `ctx.workflowEngine` | One engine per context; worker-thread provider executes model-authored scripts; workflow and Ralph tools consume it. Worker isolation is containment, not a security boundary. [S12] [S33] | Complete seam. |
| `ctx.jobs` | Owner-fenced background registry; local provider; job tools read/list/wait/kill and completion notices. Storage is process-local. [S14] | Complete seam for live process work, not durable scheduling. |
| Schedule | Three Agent-scoped tools manage durable delayed/absolute/fixed-rate reminders; due work becomes an ordinary later turn in the same live Session. [S15] | Tool/event domain, no independent service or provider role. |
| `ctx.webhookRuntime` | Authenticated adapters dispatch trusted rules; non-null rules create ordinary Sessions. No queue, retry, dedupe or completion state. [S16] | Core runtime plus provider adapters; intentionally not a durable orchestration seam. |
| `ctx.workspaceRegistry` | Durable named/ordered directory projects and Session membership for Host UI; no tools, prompt text or Session events. [S28] | Host-plane core entity service over storage-domain. |

### Identity, permissions and policy

| Service | Current role and constraints | Capability-role status |
|---|---|---|
| anonymous user id | Random home-scoped UUID sent with telemetry, feedback acknowledgements and DeepSeek requests; no account data or Cordis service. [S23] | Library, not an authentication/identity seam. |
| `ctx.credentials` / `ctx.authorization` / `ctx.settings` | Credentials are named references resolved per operation; local provider stores secrets; authorization registry hosts human-assisted credential acquisition; settings layer config and user values. [S30] [S2] | Credential and settings seams exist; “authorization” here obtains credentials, not actor/resource access control. |
| `ctx.approval`, `approval/*` | Closed one-shot outcomes; absence, bad answerers and errors fail closed; `ask` or `never` policy; asked/decided audit pair. [S17] | Fixed mechanism with answerer listeners and tool/sandbox Consumers. |
| `ctx.permissionPresets`, `permission/preset` | User-facing preset combines sandbox mode and approval policy; defaults include workspace-write/ask and danger-full-access/never. [S18] | Core policy convenience service; enforcement remains in owning knobs. |
| `ctx.sandbox` / `ctx.sandboxPolicy`, `sandbox/mode` | Per-call filesystem-effect confinement with reported full/partial enforcement; read-only, workspace-write and danger-full-access modes. Network/process visibility are out of scope. [S19] | Complete process-sandbox seam plus policy service. |
| tool policy | `tools/pre-execute` can allow/deny/ask; guards can only reduce permission; enforcement runs inside the execution operation. [S20] | Extensible policy points in the core tool Consumer. |

### Interaction, tools and extension experiences

| Service / extension | Current role and user experience | Capability-role status |
|---|---|---|
| `ctx.tools` | Scoped registry, model schema projection, guarded execution, canonical JSON output, durable call/result and replayable presentation metadata. [S20] | Core registry and execution pipeline; model-facing capability Consumers register here. |
| `ctx.commands` | Slash commands are discovered and run directly against an Agent without a model turn; run/done lifecycle is logged. [S22] | Core human-command registry with plugin-owned handlers. |
| `ctx.userQuestions` | Structured single/batched questions and UI presentation intent; Agent-scoped answerer waterfall pauses the caller. [S21] | Interaction seam implemented by fixed service plus channel listeners and tool Consumers. |
| hook bridges | Existing Claude Code/Codex command hooks intercept Session start, prompt admission, tools and turn stopping; they may block, inject context or force continuation. [S3] [S34] | Compatibility Consumers over public Agent/tool events, not loop forks. |
| capability execution seams | `ctx.fs`, `ctx.shell`, `ctx.subprocess`, `ctx.terminals`, `ctx.codeRuntime`, `ctx.web`, `ctx.lsp` and `ctx.spillStore` separate Service Definitions, providers and model/tool Consumers where roles vary. [S2] | Reusable complete seams; factory code should consume these rather than provider packages. |

### Evidence, persistence and read models

| Service | Current role and constraints | Capability-role status |
|---|---|---|
| `ctx.sessions` | In-memory append-only Session store and durable event firehose; model history is derived from surface events. [S25] | Core source of truth. |
| `ctx.sessionPersistence` | Backend-neutral event persistence with JSONL default and SQLite option; `session/flush` is the durability checkpoint. [S26] | Complete seam with two providers and many Consumers. |
| `ctx.sessionProjections` / cache | Plugins register event folds producing current values; cache checkpoints enable cold reads without full-log replay. [S2] [S26] | Core projection services, reusable for new durable domains. |
| `ctx.sessionQuery` | Live-preferred exact reads, filters, search, lineage and event relationships; SQLite supplies FTS; model tools and export consume it. [S27] | Complete query seam. |
| `ctx.sessionTelemetry` | Captures/redacts Session records and hands them to an OTel backend under sharing modes. [S26] | Complete outbound seam; not an evidence registry. |
| feedback | `/feedback` records Session remarks; message-feedback stores ratings/notes outside model history and telemetry. [S29] | Independent product feedback domains. |

## Durable Session-event inventory

**Fact.** At the researched commit the generated persistence catalog contains 51 event types. Only `user/message`, `assistant/message` and `tool/result` are model-surface events; every other type is log-only. Plugins extend `SessionEventMap` through declaration merging, and downstream plugins may add events beyond this in-repository catalog. [S4] [S25]

| Family | Events at `cd5ef814…` | Factory relevance |
|---|---|---|
| Agent / composition | `agent/inbox/spliced`, `agent-preset/selected`, `model/selection`, `subagent/model-selection-policy` | Queue projection and exact composition/model facts. [S4] |
| Approval / permissions | `approval/asked`, `approval/decided`, `approval/policy`, `permission/preset`, `sandbox/mode` | Replayable action decisions and current safety knobs. [S4] |
| Conversation / request | `user/message` **surface**, `assistant/chunk`, `assistant/message` **surface**, `request/header`, `request/context`, `llm/retry`, `llm/retry-started` | Reconstructable model input/output, route and retries. [S4] [S7] |
| Loop lifecycle | `turn/start`, `turn/end`, `step/start`, `step/end`, `tool/call`, `tool/result` **surface**, `tool/code-dispatch-start`, `tool/code-dispatch` | Execution enclosure and tool evidence. [S4] |
| Commands / hooks | `command/run`, `command/done`, `hook/invoked`, `hook/result` | Direct-human and compatibility-hook audit. [S4] |
| Specification / collaboration | `goal/change`, `plan/mode`, `todo/write`, `schedule/change` | Existing objective, plan, task and reminder state. [S4] |
| Compaction | `compaction/start`, `compaction/prune`, `compaction/summary`, `compaction/end` | Model-surface replacement provenance and recovery. [S4] |
| Session metadata / provider delivery | `session/end-seed`, `session/title`, `session/title-llm-request`, `session-log-deepseek/delivery-accepted`, `web/deepseek-search-llm-request` | Lifecycle boundary, naming and external-request audit. [S4] |
| Subagent / experimental team | `subagent/descriptor`, `team/member`, `team/message/queued`, `team/message/delivered`, `team/task` | Child identity; private experimental roster/mailbox/task DAG. [S4] |
| Workflow presentation | `tool-workflow/run-start`, `tool-workflow/agent-start`, `tool-workflow/agent-end`, `tool-workflow/run-end` | Durable Chat progress record, not resumable engine state. [S4] [S12] |
| Feedback | `feedback/record` | Session-level human feedback signal. [S4] |

**Recommendation.** New Session-scoped factory facts should declaration-merge named event families and provide strict folds, invariants, projections and UI/tool Consumers. Cross-Session work-item, organization or artifact state should not be forced into one conversation log; use `ctx.storageDomain` or a new durable Service Provider and place only references/observations in Session events. [S2] [S25]

## Reusable seams

1. **Event-sourced domain pattern.** Goal, plan, todo, schedule and permission packages show how a plugin owns event vocabulary, strict replay, lifecycle checks, projection and interaction without changing the loop. [S4] [S9] [S10] [S11] [S15]
2. **Capability trio.** A swappable capability consists of a Service Definition, one or more Service Providers and one or more Consumers; package splitting follows independent evolution, not ceremony. [S35]
3. **Scoped composition.** Agent contexts scope tools, prompt sections, listeners and preset composition; registrations are reversible effects. This is the right mechanism for factory worker personas and per-role tool sets. [S1] [S24]
4. **Execution orchestration.** Reuse subagents for child work, workflows for fan-out scripts and jobs for process-local background ownership. Add durability around them only when a concrete factory requirement exceeds their documented limits. [S12] [S13] [S14]
5. **Policy enforcement points.** Tool guards and pre-execute waterfalls, sandbox policy resolution and one-shot approvals already separate policy from execution while enforcing at the operation that acts. [S17] [S19] [S20]
6. **Read models and evidence navigation.** Session projections provide current values; Session Query provides exact events, semantic search, lineage and source/replacement traces; attachments provide durable binary references. [S2] [S27]
7. **Human and automation adapters.** Commands, structured questions, approval answerers, Host Remote services, ACP and verified webhook adapters provide Consumers without making UI or transport part of a domain service. [S16] [S17] [S21] [S22]
8. **Profile/bundle delivery.** Factory packages should ship as patchable bundles/profile layers rather than new executable entry points or caller-supplied inline application trees. [S1] [S31]

## Missing capability roles

The first column is a **fact inferred from the commit-pinned generated service/event catalogs and owning docs**; the final column is a **recommendation**.

| Missing current capability | Evidence of absence or limit | Roles needed if Wayfinder chooses to add it | Recommendation |
|---|---|---|---|
| Enterprise principal identity | Identity is anonymous home correlation only; no principal/authentication service appears in the capability graph. [S2] [S23] | Service Definition for principals/claims; authentication providers; Host/API/policy/audit Consumers | Add before claiming multi-user authorization or accountable approvals. Keep anonymous id separate. |
| Resource authorization / policy decision | Current “authorization” obtains credentials; approvals are one-shot; presets combine sandbox/approval; tool guards lack enterprise principal/resource vocabulary. [S17] [S18] [S20] [S30] | Policy Decision Service Definition; policy providers; Consumers at Session create, tool execute, artifact access, workflow start and release | Enforce decisions in owning operations. Prompt omission and UI hiding are not authorization. |
| Durable specification and work-item domain | Goal is one objective; todo is minimal list; plan is soft guidance; catalogs contain no spec/work-item service/event. [S2] [S4] [S9] [S10] [S11] | Definition for specs/work items/revisions/relations; durable provider; model tools, commands, UI, webhook/API Consumers | Build separately and reference from Goals/Sessions. Do not inflate goal or todo into a factory database. |
| Durable factory-run orchestration | Workflow runs are foreground and non-resumable; jobs are process-local; webhook has no completion state. [S12] [S14] [S16] | Run Definition; durable queue/lease provider; workflow/subagent worker Consumer; UI/API/evaluator Consumers | Add only for cross-process retry/resume. Existing workflow remains the execution adapter. |
| Evidence / attestation / artifact registry | Session history and query exist, but generated catalogs contain no typed build/test/artifact/attestation domain. [S2] [S4] [S27] | Evidence Definition; content-addressed artifact and metadata provider(s); tool/CI/reviewer producers; policy/UI/release Consumers | Make evidence immutable and link it to spec revisions, runs, actors and source commits. |
| Independent evaluator / completion certificate | Goal actor marks complete/blocked authoritatively; its Agent Note explicitly defers an independent evaluator/certificate. [S9] | Evaluation Definition; evaluator providers; completion-policy and UI Consumers | Keep evaluation outside GoalService and Agent loop; write a durable decision that cites evidence. |
| Durable external queue and scheduler | Webhooks are fire-and-forget; Schedule needs the original live Session and is best-effort at-least-once; jobs are process-local. [S14] [S15] [S16] | Queue/schedule Definition; persistent provider; webhook/timer producers; worker/status Consumers | Add for enterprise delivery guarantees rather than weakening current narrow semantics. |
| Persistent grants / approval governance | Only `allowed-once` exists; grant scope, storage and revocation are deferred. [S17] | Grant Definition; durable provider; policy/approval/admin Consumers | Design scope, expiry, revocation and actor identity together; do not add `allow_always` as a UI-only option. |

## Agent-loop constraints

### Facts

- The loop's owned job is “call the model, run the tools, repeat”; everything else belongs to plugins on public services/events. [S5] [S6]
- Durable Session events record replayable facts; live `agent/*` events coordinate in-flight work; capability events attach policy/adapters without importing the loop. [S1] [S3]
- Waterfalls require `next()` to delegate; serial and parallel modes have distinct ordering semantics; notifications are emits. [S3] [S6]
- Model-visible input must be logged/referenced so requests are reconstructable. A plugin needing current-step messages uses `agent/pre-step`; later context uses the inbox/injection channel. [S7]
- Tool arguments cannot be rewritten after acceptance; policy is enforced in the tool pipeline, and monotonic guards cannot convert denial into permission. [S20]
- Agent-scoped contributions belong in the Agent plane; shared persistence, query, projections, storage, settings, credentials, telemetry and provider registries remain Host-plane services. [S24]
- The loop has no built-in turn budget; a policy bounds runaway turns through existing lifecycle extension points such as cancellation or `agent/turn-stopping`. [S5]

### Factory behavior that must not accumulate in `agent-loop`

| Proposed behavior | Why loop ownership is wrong | Correct extension home |
|---|---|---|
| Specification/work-item state | Independent durable domain with UI/API/tool producers and non-model readers | New domain service + Session references/events + projections |
| Requirement decomposition / DAG scheduling | Orchestration policy, not model/tool execution mechanics | Workflow/subagent Consumers or new durable run/queue seam |
| Enterprise authentication and RBAC/ABAC | Host/transport and operation authorization spans more than model turns | Principal and policy services; enforce in API/tool/artifact operations |
| Approval routing and grant storage | Existing answerer/policy seam already owns one-shot decisions | `ctx.approval` Consumers plus separate durable grants service |
| Evidence evaluation and release decisions | Must inspect authoritative artifacts/results and remain independently auditable | Evidence/evaluation/release services and durable decision events |
| External queue, retries, dedupe and schedules | Must survive process/Session liveness and coordinate workers | Durable queue/scheduler provider; webhook/timer Consumers |
| Factory-wide status dashboards | Read model over many durable entities, not execution control | projections/query/API/UI |
| Persona/tool selection | Already Agent-scoped composition | presets, scoped registrations, system-prompt/tool registries |
| Context injection for a factory fact | Direct loop mutation would violate reconstructability | append/reference a durable event, then use `agent/pre-step` or inbox |
| New model-facing capability | Provider swaps must not alter model contract | Service Definition + Provider + tool Consumer registered on `ctx.tools` |

**Recommendation.** Change `agent-loop` only if the generic turn/step lifecycle itself changes. Such a change must update `docs/architecture.md`, both SDK projections where applicable, Session event vocabulary, snapshots and lifecycle tests. Otherwise mount a plugin.

## Risks and unknowns

### Current-state risks (facts)

- **Pre-release persistence:** `SESSION_FORMAT_VERSION` is `0`; old formats are rejected and no compatibility promise exists. Factory records need an explicit migration/version policy before external reliance. [S4] [S25]
- **Workflow trust:** worker threads and `node:vm` contain buggy scripts but are not a hostile-code security boundary; current workflow runs are not journaled/resumable. [S12]
- **Lifecycle durability gaps:** jobs are process-local; webhooks have no queue/retry/dedupe/status; Schedule acts only for a live original Session and has a crash interval that can repeat delivery. [S14] [S15] [S16]
- **Permission scope:** sandbox mode governs filesystem effects, not network or process visibility; enforcement may report `partial`. Approvals have no persistent grant. [S17] [S19]
- **Goal semantics:** one Goal exists per Session; parallel objective graphs, cross-Session goals and independent completion certification are absent. [S9]
- **Agent retention:** the preset design note records that the Web host retains every Session Agent it has touched and leaves idle eviction as Host-owned work. A factory with many Sessions must validate memory/lifecycle behavior. [S24]
- **Experimental teams:** team roster/mailbox/task events exist only for the private opt-in experimental capability; they are not a supported factory task system. [S1] [S4]

### Research unknowns

- Required enterprise tenancy, principal source, policy language and audit retention are unspecified by ticket #7.
- Required factory unit is unspecified: one Session, a cross-Session work item, a repository change, a build, or a release. This choice determines whether Session events or storage-domain should own state.
- Required execution guarantees are unspecified: foreground, at-least-once, exactly-once effect intent, resumable workflow or externally reconciled work.
- Required evidence standard is unspecified: raw transcript, structured test/build evidence, signed attestations or independent evaluator verdicts.
- Current catalogs prove in-repository registrations only; out-of-tree profile plugins can add services and Session events not visible at the researched commit. [S2] [S4]

## Source index

All links below are pinned to researched commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`.

[S1]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/architecture.md
[S2]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/capability-seams.md
[S3]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/event-producer-consumer.md
[S4]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/persistence-catalog.md
[S5]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/core/agent-loop/README.md
[S6]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/architecture/2026-06-11-microkernel-event-taxonomy.md
[S7]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md
[S9]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/feature/2026-07-19-persisted-same-session-goal-domain.md
[S10]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/plan.md
[S11]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/todo.md
[S12]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md
[S13]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/subagent.md
[S14]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/jobs.md
[S15]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/schedule.md
[S16]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/webhook.md
[S17]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/feature/2026-07-06-approval-seam.md
[S18]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/permission-presets.md
[S19]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/sandbox.md
[S20]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/tools.md
[S21]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/user-questions.md
[S22]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/commands.md
[S23]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/identity/anonymous-user-id/README.md
[S24]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/architecture/2026-08-03-per-session-agent-presets.md
[S25]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/session.md
[S26]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/session/README.md
[S27]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/session-query.md
[S28]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/workspace/README.md
[S29]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/feedback/README.md
[S30]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/README.md
[S31]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/bundle/base/package.json
[S32]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/subagent/subagent/package.json
[S33]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/workflow/workflow/package.json
[S34]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/hooks/README.md
[S35]: https://github.com/alanw707/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/architecture/2026-06-13-capability-seams.md
