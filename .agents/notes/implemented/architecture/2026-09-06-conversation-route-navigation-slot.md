# Agent Note: Global route navigation in the sidebar

Status: implemented

English | [中文](2026-09-06-conversation-route-navigation-slot.zh.md)

## Problem

The Software Factory dashboard is a global browser route, not a Conversation View. Rendering its link beside Conversation tabs mixed global navigation with per-Session View controls and made placement depend on the Conversation header.

## Decision

`ui-sidebar` declares the root-scoped `sidebar.primary.action` list slot between New Session and the workspace/session browser. The sidebar owns row geometry and passes its wide/rail state plus a theme-compatible class. Route contributors remain normal links rather than claiming tab semantics.

`@deepseek-ai/dsh-host-task-dashboard` has a browser face. That face registers localized Software Factory navigation through the sidebar slot and selects `/command-center` through the shell's route chain; the Host face contributes only the API and does not inject fixed HTML into the Web index. The dependency policy keeps this service-owning package classified as a configured Host, so its Host service peers do not flatten merely because the package also publishes a browser entry.

## Alternatives considered

**Register Software Factory as a Conversation View.** Rejected because `/command-center` is a global route with its own API state, not a target rendered by `conversation.view` or selected per Session.

**Render Software Factory in the Conversation header.** Rejected because the header belongs to a Session and its tab row represents Conversation Views. Global access belongs in the layout-owned sidebar.

**Keep a standalone HTML route and adjust its offsets.** Rejected because duplicate shell markup would diverge from DSH theme, navigation, responsive layout, and accessibility behavior.

**Relocate standalone content with browser DOM code.** Rejected because it depends on another package's private DOM structure and bypasses the slot ownership model.

## Consequences

Software Factory is available from the expanded sidebar, its collapsed rail icon, and `Ctrl+Shift+T`, with theme tokens and a localized accessible label. The link is present independently of the active Session and is absent only when the task-dashboard browser package is not composed. Its route content remains inside AppFrame, so shell navigation and responsive behavior remain shared with Chat. User-initiated Session opens from the Workspace browser return to `/` when another route owns the center; automatic startup selection leaves the current route unchanged, so sidebar Session clicks expose the selected Chat session.

Adding the browser face makes task-dashboard a Host/Client package with explicit face-specific TypeScript programs and a client bundle. Compositions that omit task-dashboard receive no Software Factory route entry.
