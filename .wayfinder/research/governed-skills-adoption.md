# Governed Skills adoption

Research ticket: [Assess the Matt Pocock Skills model for governed adoption](https://github.com/alanw707/deepseek-harness/issues/8)

Parent map: [Chart the enterprise software factory](https://github.com/alanw707/deepseek-harness/issues/4)

Research date: 2026-09-01

## Executive finding

### Facts

Matt Pocock's model is a curated MIT-licensed collection built on the open Agent Skills directory and `SKILL.md` format, with client-specific invocation metadata for Claude Code and Codex. The current source has 25 promoted Skills, eight explicitly unstable Skills, and four unpromoted miscellaneous Skills. The promoted set is distributed either as a managed Claude Code plugin or as editable files through Vercel's `skills` CLI.[M1][M2][M4][M8][M9][M10][V1]

Its strongest reusable ideas are progressive disclosure, a deliberate split between human-only orchestration and model-invokable disciplines, explicit Skill-tool composition, small procedures with completion criteria, and issue-backed durable artifacts. Its weakest enterprise properties are absent per-Skill provenance and versions, convention-only composition, client-specific policy fields, no declared capability or data policy, no signatures, and no published evaluation suite.[A1][A2][M3][M6]

The repository calls the Engineering Skills daily-use tools and calls `grill-me` and `grill-with-docs` its most popular Skills. Promotion into the official plugin, release history, and repeated source revisions provide evidence of active use and maintenance, not measured reliability. The repository has only a release workflow and no test, validation, security, or behavioral-evaluation workflow, so none of the Skills is proven for enterprise use by published outcome data.[M1][M6][M7][M8]

### Recommendation

Adopt the format and several bounded procedures, not the upstream bundle as a production control plane. Import approved Skills into an internal registry at immutable commits, retain upstream notices, add organization-owned metadata and policy overlays, evaluate each Skill against supported harness/model combinations, and publish signed internal releases. Keep upstream text and organization policy separate so synchronization remains reviewable.

Treat an Operational Skill as a governed, versioned procedure. Treat a Workflow as the durable composition of Skills, policy decisions, human checkpoints, and evidence. A Skill may recommend or request capabilities; only the factory policy engine may grant them.

## Source and license inventory

| Owner and source | Role in the model | Version inspected | License facts |
|---|---|---|---|
| `mattpocock/skills` | Canonical content, bucket policy, cross-Skill conventions, Claude plugin manifest | `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`; latest release `v1.2.3` resolves to `6acc160e4e0cd062dbbbd7a1b26ae92855edf07e` | Repository and plugin declare MIT; redistribution requires preserving the copyright and permission notice.[M2][M4] |
| `agentskills/agentskills` | Open `SKILL.md` specification and client integration guidance | `69ef37e9424c0a7ea9dd2293b559e43ec8176379` | Code and specification are Apache-2.0; documentation is CC-BY-4.0.[A3][A4][A5] |
| `vercel-labs/skills` | Cross-client discovery, installation, lock files, and update CLI used by the upstream instructions | `v1.5.23`, commit `435076e78988e1e6ec40d00b0b1d76bdbbc5419a` | MIT.[V1][V4] |
| `anthropics/claude-plugins-official` | Official Claude marketplace listing and immutable source pin | `ed404106fcd80ba98ecb7c851e531dcb626d13b7`; listing pins Matt source `0ab1b63a410a03d3627979a109c8695de27af954` | Marketplace repository is Apache-2.0 and directs users to each external plugin's own license. Its README warns that Anthropic does not control external plugin contents or changes.[C1][C2][C3] |
| OpenAI Codex documentation | Authority for `agents/openai.yaml`, explicit `$skill` invocation, and implicit-invocation policy | Live documentation retrieved 2026-09-01 | Documentation was consulted, not copied; no repository license claim is made.[O1] |
| Claude Code documentation | Authority for `/skill-name`, `disable-model-invocation`, and plugin update semantics | Live documentation retrieved 2026-09-01 | Documentation was consulted, not copied; no repository license claim is made.[C4][C5] |
| Installed first-party copies | Evidence of actual installation and lock behavior in this research environment | `/home/alanw/.agents/.skill-lock.json`, schema 3, observed 2026-09-01 | The 25 promoted Matt Skills, six older in-progress Skills, and four miscellaneous Skills are recorded as copies from `mattpocock/skills`; Matt's MIT license remains the source license.[L1] |

The Agent Skills specification permits optional `license`, `compatibility`, `metadata`, and experimental `allowed-tools` fields. None of Matt's 25 promoted `SKILL.md` files at the inspected commit declares those fields; licensing and versioning exist only at repository/plugin level.[A1][M2][M4]

## Skill file and invocation model

### Facts: portable core

A Skill is a directory whose required entry point is `SKILL.md`. The file contains YAML frontmatter and Markdown instructions. `name` and `description` are required; a Skill may bundle scripts, references, assets, and arbitrary other files. The specification recommends loading only catalog metadata at startup, the full `SKILL.md` on activation, and referenced resources on demand. It recommends fewer than 5,000 instruction tokens, fewer than 500 lines, shallow relative references, and `skills-ref validate` for format validation.[A1]

The specification does not define installation paths, invocation syntax, dependencies, output types, risk, or lifecycle. Client guidance describes project, user, organization, and built-in scopes; deterministic collision precedence; trust checks for project Skills; explicit activation through slash or mention syntax; and optional activation tools with permission enforcement and telemetry.[A2]

### Facts: Matt's client extensions

Matt divides every promoted Skill along one axis. A user-invoked Skill is available only when the human names it; a model-invoked Skill may also be selected automatically from its description. Claude expresses human-only invocation with `disable-model-invocation: true`; Codex expresses it with `policy.allow_implicit_invocation: false` in a sibling `agents/openai.yaml`. Codex's sidecar also carries display metadata.[M3][O1][C4]

Users invoke Claude Skills as `/skill-name` and Codex Skills explicitly as `$skill-name`. Model-invoked Skills rely on rich trigger language in `description`; human-only Skills use short human-facing descriptions and are removed from model discovery.[M3][O1][C4]

The promoted set contains nine human-only Engineering orchestrators, nine model-invoked Engineering disciplines, five human-only Productivity tools, and two model-invoked Productivity disciplines.[M8][M9]

## Composition and update behavior

### Facts: composition

Matt's canonical composition rule says an operative dependency must instruct the model to call the Skill tool with one named model-invoked Skill. One tool call takes one Skill; two dependencies require two calls. A Skill cannot call a human-only Skill. Shared material stays with its owning Skill and is reached by invocation rather than deep cross-directory links.[M3]

`grill-with-docs` composes `grilling` and `domain-modeling`; `wayfinder` composes those disciplines and dispatches `research` subagents onto separate branches. `setup-matt-pocock-skills` creates repository-local issue-tracker, triage-label, and domain-document configuration used by later flows. Hard dependencies tell the human to run setup; soft dependencies degrade when project context is absent.[M17][M18][M20]

These relationships are prose, not machine-readable dependency declarations. No manifest declares dependency versions, required capabilities, input/output records, cycle rules, failure propagation, or transactional behavior. The convention is not statically enforced: the inspected `implement` Skill still uses bare `/tdd` and `/code-review` operative wording even though the canonical rule requires explicit Skill-tool calls.[M3][M19]

### Facts: installation and synchronization

The Claude route installs all 25 promoted Skills as one read-only plugin. The manifest explicitly enumerates promoted paths and excludes `in-progress` and `misc`; Claude's official marketplace points to an immutable Matt source commit. Marketplace auto-update is enabled by default, while Claude version resolution and caching depend on marketplace/source and plugin versions.[M1][M4][M5][C1][C5]

The cross-client route runs `npx skills@latest add mattpocock/skills`. The CLI can select individual Skills and agents, installs one canonical copy with target-agent symlinks by default when paths differ, or makes independent copies with `--copy`. Project installs record `source`, optional `ref`, source path, and a computed content hash in a checked-in `skills-lock.json`; global installs record analogous data in a user lock file.[V1][V2][V4]

`npx skills update` discovers installed Skills, fetches their stored source and optional ref, compares content, and refreshes selected project or global copies. Upstream deletions require confirmation interactively and are skipped in noninteractive mode. The Matt README describes this route as user-owned editable files that change only when the user requests an update.[M1][V1][V3]

The source has three distinct content identities while every inspected plugin manifest reports version `1.2.3`: release tag commit `6acc160`, official marketplace pin `0ab1b63`, and current source commit `6654f6b`. Current source is 39 commits after the release tag and six commits after the marketplace pin. Bundle semver therefore does not uniquely identify Skill content; an immutable commit and content digest are required for reproduction.[M4][M7][C1]

The installed Matt lock entries include folder hashes and update times but omit `ref` and resolved commit SHA. This records change detection without enough identity to reconstruct the exact upstream tree independently.[L1][V2]

## Candidate Skills and classification

### Evidence standard

“Promoted” means included in Matt's stable Engineering or Productivity buckets and Claude plugin. “Used daily” and “most popular” are owner statements. “Installed” means present in the local first-party lock. None means a Skill has passed enterprise security, policy, cross-model, or outcome evaluations.[M1][M8][L1]

### Recommendation: adopt

“Adopt” means retain the procedure substantially unchanged inside the governance envelope described below, not install the upstream file directly into production.

| Skills | Why they are candidates | Required enterprise additions |
|---|---|---|
| `diagnosing-bugs` | Tight red-capable feedback loop, minimization, ranked falsifiable hypotheses, instrumentation cleanup, regression check, and explicit secret redaction form a bounded diagnostic procedure.[M11] | Environment authorization, sensitive-artifact handling, production-instrumentation approval, time/cost bounds, and evidence capture. |
| `research` | Primary-source ownership and one cited artifact align directly with decision evidence.[M12] | Source allowlists, retrieval evidence, immutable citations, data-classification rules, claim-level review, and no implicit branch/push authority. |
| `tdd` | Red-before-green, vertical slices, public-interface testing, and pre-agreed test locations are reusable quality discipline.[M13] | Project test policy, risk-based exceptions, generated-test provenance, mutation or sensitivity checks, and required evidence records. |
| `resolving-merge-conflicts` | Intent is traced to both sides before a hunk is resolved, followed by repository checks.[M14] | Protected-branch policy, conflict ownership, required reviewers for sensitive files, and auditable resolution evidence. |
| `grilling` | It separates facts from decisions, asks only the currently unblocked question frontier, and requires human confirmation before action.[M15] | Identity and authority checks for decision makers, decision sensitivity labels, timeout/escalation rules, and durable decision records. |

### Recommendation: adapt

| Skills | Valuable pattern | Why direct adoption is unsuitable |
|---|---|---|
| `domain-modeling`, `grill-with-docs` | Shared terminology, edge-case stress, and sparse decision records | Must write to factory-owned Delivery Specification and decision records, enforce authorship, and avoid a hardcoded `CONTEXT.md`/ADR layout. |
| `code-review` | Independent Standards and Spec axes reduce mutual anchoring.[M16] | Add security, policy, operational-readiness, and evidence axes as configured evaluations; replace hardcoded smell doctrine and optional subagent behavior with organization policy. |
| `to-spec`, `to-tickets`, `wayfinder` | Intent synthesis, vertical delivery slices, dependency frontier, and decision-only map | Replace generic issue bodies and labels with versioned Delivery Specification, Workflow, dependency, approval, and evidence records. Concurrency needs atomic claims and durable checkpoints rather than assignee convention. |
| `triage`, `implement` | Verification before classification; test-and-review implementation flow | These close issues, change labels, commit code, and can trigger broad work. Factory risk tiers, approvals, idempotency, rollback, and system-of-record adapters must own those effects. |
| `prototype` | Cheap executable evidence to answer a named question | Require isolated execution, synthetic or approved data, artifact retention, accessibility/security checks appropriate to fidelity, and explicit promotion prohibition. |
| `setup-matt-pocock-skills` | Repository-specific configuration rather than hidden defaults | Replace interactive file scaffolding with organization provisioning, policy bundles, role bindings, system-of-record adapters, and validation. |
| `codebase-design`, `improve-codebase-architecture` | Coherent interface-design lens and evidence-oriented refactor candidates | Treat the deep-module vocabulary as one optional architecture policy, not universal doctrine; integrate existing DeepSeek Harness architecture and decision authority. |
| `wizard` | Converts human-only external steps into a repeatable guided procedure | It handles credentials, CI secrets, migrations, and cutovers. Require secret brokers, masked fields, dual control where needed, verified current instructions, resumability, and rollback. |
| `ask-matt` | Human-facing routing across a large catalog | Replace a static prose router with registry search, eligibility/policy filtering, recommendation evidence, and version-aware Workflow templates. |
| `handoff` | Explicit context transfer | Fold into durable checkpoints and resumable Workflow state; a free-form handoff document cannot be the authoritative execution record. |
| `writing-for-agents`, `to-questionnaire` | Agent-readable procedure authoring and asynchronous expert input | Integrate with governed Skill authoring, localization, records, access control, and response attribution rather than ship as general-purpose commands. |

### Recommendation: exclude from the governed baseline

| Skills or bucket | Reason |
|---|---|
| `grill-me` | Duplicates the `grilling` primitive without durable project records; expose a Workflow preset instead. |
| `teach`, `wait-what` | Useful personal interaction aids, not Operational Skills that advance a governed software outcome. Keep outside the factory baseline. |
| All eight `in-progress` Skills | Upstream explicitly permits change or disappearance without warning and excludes them from the plugin. Reassess only after promotion and evaluation.[M10] |
| All four `misc` Skills | Upstream marks them rarely used and unpromoted; some are product-specific or duplicate factory hooks and repository policy.[M21] |
| Empty `deprecated` bucket and removed names | Do not preserve aliases unless an internal migration requires them; upstream itself offers no compatibility promise for removed Skill names.[M7] |

## Enterprise adoption gaps

### Facts

The portable format identifies only a name, trigger description, instructions, and optional resources. Optional metadata is string-valued and has no standardized fields for provenance, dependency constraints, publisher identity, signatures, risk, data handling, side effects, evaluation, or lifecycle.[A1]

Matt's human-only flags constrain discovery but do not authorize tools or side effects. The promoted Skills declare no `allowed-tools` or compatibility metadata, and `allowed-tools` is experimental and client-dependent in the base specification.[A1][M3]

The Claude marketplace warns users to trust external plugins themselves. Agent Skills client guidance separately recommends trust checks before project Skills inject instructions. These are installation safeguards, not enterprise publisher verification, runtime least privilege, or supply-chain attestation.[A2][C2]

### Recommendation: governed Operational Skill record

Every internally published Skill release should contain or resolve the following records:

| Record | Required fields |
|---|---|
| Identity | Organization namespace, immutable Skill ID, human display name, Skill semantic version, lifecycle state, owning team, maintainers, approvers |
| Provenance | Upstream repository URL, immutable commit, source subpath, upstream tag if any, normalized content digest, import time, importer, patch set, distilled-source URLs and refs, last-reviewed time |
| Legal | SPDX license expression per component, bundled notices, copyright owner, modification notice, redistribution decision, legal review status |
| Compatibility | Agent Skills specification revision, supported harness releases, model families, operating systems, required tools and adapters, known limitations |
| Composition | Exact Skill dependencies, accepted input record types, emitted output/evidence record types, preconditions, completion conditions, retry/idempotency behavior, failure and compensation behavior |
| Capability request | Filesystem roots and modes, network destinations, subprocesses, credentials by logical name, systems of record, maximum duration/cost, side-effect class |
| Policy overlay | Risk tier, allowed roles and tenants, explicit/implicit invocation, required approvals, data classification and residency, retention, model/provider allowlist, emergency-stop behavior |
| Evaluation | Evaluation-suite revision, supported model/harness matrix, report digest, reviewer decision, expiry or reevaluation trigger |
| Distribution | Internal package digest, signature and attestation, registry channel, rollout cohort, superseded version, rollback target |

Upstream `SKILL.md` and resources should remain an immutable imported layer. Organization instructions should be a separately versioned overlay with explicit precedence. Material upstream edits become a new internal Skill release; runtime mutation of installed text is prohibited.

### Recommendation: policy and execution

Resolve requested capabilities before activation. A Skill's declaration is a request, never a grant. Apply tenant, identity, Delivery Specification, environment, and risk policies in the control plane; issue short-lived credentials only to isolated workers; log denials and approvals.

Use human-only invocation for timing-sensitive or consequential procedures, but do not treat it as sufficient approval. Commits, issue transitions, deployments, migrations, secrets, production instrumentation, external comments, and destructive operations need independent policy checks at the tool operation.

Log the exact Skill digest, overlay version, Workflow version, model/provider, policy decision, actor, inputs, tool events, outputs, evidence, approvals, and intervention history for every activation. Link those records to the Delivery Specification and systems-of-record identifiers.

Make Workflow composition machine-readable and acyclic. Validate dependency availability and compatibility before execution. The Workflow, not prose inside a Skill, owns durable state, parallel frontier claims, retries, cancellation, compensation, human checkpoints, and final completion.

### Recommendation: evaluation and promotion

1. Run static admission checks: strict Agent Skills validation, path and archive safety, license/notice verification, secret scanning, executable and dependency inventory, prohibited instruction checks, dependency-cycle detection, and capability-policy compatibility.
2. Run behavior evaluations on versioned task corpora: intended-trigger recall, unintended-trigger rate, instruction adherence, completion-criterion accuracy, tool selection, policy-denial behavior, side-effect containment, evidence quality, recovery after tool failure, and adversarial prompt resistance.
3. Run domain evaluations for each procedure. Examples include diagnosis root-cause accuracy, research citation entailment and source quality, review finding precision/recall, TDD test sensitivity, merge semantic correctness, and Workflow record completeness.
4. Execute the matrix across supported model, harness, tool-provider, and policy-overlay versions. Record cost, latency, interventions, retries, and failures separately from output quality.
5. Require review and signed promotion from quarantine to experimental, canary, approved, and deprecated channels. Reevaluate on Skill, overlay, model, harness, tool, policy, or material upstream-source changes. Preserve immediate rollback to the prior digest.

### Recommendation: upstream synchronization

1. Mirror approved upstream repositories and poll immutable upstream refs on a schedule.
2. Compare the recorded upstream commit and per-Skill content digest with the new tree. Open a change request containing upstream commits, file diff, license changes, dependency/capability changes, and affected internal releases.
3. Rebase the organization patch layer mechanically where possible. Keep policy overlays separate; never merge policy silently into imported prose.
4. Run the full affected evaluation matrix and security/legal checks. Require owner approval for behavior changes and policy-owner approval for changed capabilities or side effects.
5. Sign and publish a new internal version, deploy to a canary cohort, monitor activation and outcome regressions, then promote or roll back. Production never follows `main`, `latest`, or marketplace auto-update directly.
6. Contribute generally useful fixes upstream and record the upstream pull request. Continue pinning the reviewed internal digest until the accepted upstream commit passes internal evaluation.

## Unknowns requiring resolution

- No published quantitative evaluation, task corpus, or success threshold was found in `mattpocock/skills`; author usage and promotion cannot establish enterprise reliability.[M1][M6]
- The Agent Skills specification has no declared specification version in `SKILL.md` and no standard dependency, provenance, signature, or lifecycle record. Whether those become standard fields remains open.[A1]
- Client extension semantics differ. Claude frontmatter and Codex sidecars implement the same human-only intent separately, while unsupported clients may ignore both. The factory must define one internal invocation policy and test every adapter.[M3][O1][C4]
- The official marketplace pin, release tag, and current source differ while plugin version remains `1.2.3`. The exact cache/update behavior for every Claude distribution and enterprise setting was not independently exercised in this research.[M4][C1][C5]
- The `skills` CLI records content hashes and optional refs but not a mandatory resolved commit in project locks. Merge or preservation semantics for locally edited files are not promised by the Matt instructions; governed adoption should not depend on in-place updates.[M1][V2][V3]
- The top-level Matt setup summary names GitHub, Linear, and local files, while the current setup Skill offers GitHub, GitLab, local Markdown, and free-form “other.” This documentation/source mismatch needs upstream clarification and supports generated or validated catalogs.[M1][M20]
- Legal counsel should decide how MIT notices and modification markers are presented when Skill prose is adapted, bundled, or used to influence generated work. This report identifies source terms but gives no legal opinion.[M2]
- Model behavior under nested Skill invocation, context compaction, concurrent subagents, and conflicting overlays needs empirical measurement in DeepSeek Harness. The open client guide recommends preserving activated instructions and deduplicating activation but does not standardize those semantics.[A2]

## Source index

### Matt Pocock primary sources

- **[M1]** [`README.md` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/README.md): model purpose, installation routes, update posture, owner usage claims, promoted catalog.
- **[M2]** [`LICENSE` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/LICENSE): MIT terms and copyright.
- **[M3]** [`.agents/invocation.md` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/.agents/invocation.md): human/model invocation split and cross-Skill composition rules.
- **[M4]** [`.claude-plugin/plugin.json` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/.claude-plugin/plugin.json): bundle metadata, version, license, and 25 promoted paths.
- **[M5]** [Claude plugin ADR at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/.agents/adr/0002-ship-as-a-claude-code-plugin.md): bucket curation, plugin constraints, official listing verification, version/update rationale.
- **[M6]** [Release workflow at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/.github/workflows/release.yml): Changesets version PR and tag automation.
- **[M7]** [`CHANGELOG.md` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/CHANGELOG.md): released fixes, promotion evidence, removals, and renamed Skills.
- **[M8]** [Engineering catalog at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/README.md): promoted Engineering Skills and invocation class.
- **[M9]** [Productivity catalog at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/productivity/README.md): promoted Productivity Skills and invocation class.
- **[M10]** [In-progress catalog at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/in-progress/README.md): beta status and compatibility warning.
- **[M11]** [`diagnosing-bugs` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/diagnosing-bugs/SKILL.md): diagnosis procedure and completion criteria.
- **[M12]** [`research` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/research/SKILL.md): primary-source research procedure.
- **[M13]** [`tdd` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/tdd/SKILL.md): testing discipline.
- **[M14]** [`resolving-merge-conflicts` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/resolving-merge-conflicts/SKILL.md): intent-based merge procedure.
- **[M15]** [`grilling` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/productivity/grilling/SKILL.md): decision-frontier interview primitive.
- **[M16]** [`code-review` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/code-review/SKILL.md): independent Standards and Spec review axes.
- **[M17]** [`wayfinder` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/wayfinder/SKILL.md): decision map, dependency frontier, and research subagents.
- **[M18]** [Setup dependency ADR at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/.agents/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md): hard and soft setup dependencies.
- **[M19]** [`implement` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/implement/SKILL.md): implementation composition wording and side effects.
- **[M20]** [`setup-matt-pocock-skills` at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/setup-matt-pocock-skills/SKILL.md): repository configuration choices and generated files.
- **[M21]** [Miscellaneous catalog at `6654f6b`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/misc/README.md): unpromoted tool-specific Skills.

### Format, installer, and client authorities

- **[A1]** [Agent Skills specification at `69ef37e`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx): directory format, metadata constraints, progressive disclosure, resources, and validation.
- **[A2]** [Client implementation guide at `69ef37e`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/client-implementation/adding-skills-support.mdx): discovery scopes, trust, invocation, permissions, compaction, and delegation.
- **[A3]** [Agent Skills README at `69ef37e`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/README.md): format ownership and license split.
- **[A4]** [Agent Skills code/specification license at `69ef37e`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/LICENSE): Apache-2.0.
- **[A5]** [Agent Skills documentation license at `69ef37e`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/LICENSE): CC-BY-4.0.
- **[V1]** [`skills` CLI README at `v1.5.23`](https://github.com/vercel-labs/skills/blob/v1.5.23/README.md): source formats, install paths, symlink/copy modes, discovery, update commands, and compatibility table.
- **[V2]** [Project lock implementation at `v1.5.23`](https://github.com/vercel-labs/skills/blob/v1.5.23/src/local-lock.ts): source/ref/path/content-hash lock fields.
- **[V3]** [Update implementation at `v1.5.23`](https://github.com/vercel-labs/skills/blob/v1.5.23/src/update.ts): source refresh, scope selection, deletion behavior, and update failure handling.
- **[V4]** [`skills` CLI license at `v1.5.23`](https://github.com/vercel-labs/skills/blob/v1.5.23/LICENSE): MIT.
- **[C1]** [Official marketplace entry at `ed4041`](https://github.com/anthropics/claude-plugins-official/blob/ed404106fcd80ba98ecb7c851e531dcb626d13b7/.claude-plugin/marketplace.json#L2153-L2168): Matt plugin source and immutable SHA.
- **[C2]** [Official marketplace README at `ed4041`](https://github.com/anthropics/claude-plugins-official/blob/ed404106fcd80ba98ecb7c851e531dcb626d13b7/README.md): external-plugin trust warning, listing behavior, and license routing.
- **[C3]** [Official marketplace repository license at `ed4041`](https://github.com/anthropics/claude-plugins-official/blob/ed404106fcd80ba98ecb7c851e531dcb626d13b7/LICENSE): Apache-2.0.
- **[C4]** [Claude Code Skills documentation](https://code.claude.com/docs/en/skills): Skill locations, `/name`, `disable-model-invocation`, and tool controls; retrieved 2026-09-01.
- **[C5]** [Claude Code marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces): marketplace refresh, automatic updates, source pins, and version resolution; retrieved 2026-09-01.
- **[O1]** [OpenAI Codex Skills documentation](https://developers.openai.com/codex/skills): `agents/openai.yaml`, `$skill`, and `policy.allow_implicit_invocation`; retrieved 2026-09-01.
- **[L1]** Installed first-party lock at `/home/alanw/.agents/.skill-lock.json`, observed 2026-09-01; local evidence only, not committed or modified.
