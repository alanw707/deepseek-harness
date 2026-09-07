---
name: DSH Command Center
description: A local, approval-first workspace for bounded project changes.
colors:
  page-bg: "#f6f7fa"
  surface: "#ffffff"
  surface-muted: "#fbfcfe"
  line: "#e3e7ef"
  line-strong: "#d4dbe7"
  text: "#202938"
  muted: "#6b7485"
  subtle: "#8a94a5"
  accent: "#516bd6"
  accent-soft: "#eef2ff"
  good: "#16845a"
  good-soft: "#e9f8f0"
  warn: "#9a6500"
  warn-soft: "#fff7df"
  bad: "#b53c3c"
  bad-soft: "#fff0f0"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "2.2rem"
    fontWeight: 760
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "0.8rem"
    fontWeight: 700
    lineHeight: 1.2
rounded:
  sm: "7px"
  md: "9px"
  lg: "14px"
  pill: "999px"
spacing:
  sm: "0.55rem"
  md: "0.8rem"
  lg: "1.35rem"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0.68rem 0.92rem"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0.68rem 0.92rem"
  status-review:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn}"
    rounded: "{rounded.pill}"
---

# Design System: DSH Software Factory

## Overview

**Creative North Star: "The Approval Ledger"**

Software Factory treats every file change as a visible, reviewable record. The route is rendered by the DSH shell, so its sidebar, theme, session chrome, and responsive frame remain unchanged. State and the next action carry attention; semantic colors distinguish review, success, and failure.

The route uses DSH typography, theme aliases, thin structural borders, and code-like panes for before-and-after content. It is a shell occupant, not a second application document or Conversation View.

**Key Characteristics:**
- Approval-first hierarchy.
- Cool neutral canvas with one indigo action accent.
- Plain-language state labels.
- Exact content shown in bounded scrollable panes.

## Colors

The palette comes from DSH theme aliases. Cool neutral layers establish the work surface; semantic aliases appear only where a state or action needs interpretation. The route does not define page colors or light/dark overrides.

### Theme aliases
- `--dsw-alias-brand-primary`: advancing actions and current progress.
- `--dsw-alias-bg-base`: route canvas.
- `--dsw-alias-bg-layer-1` and `--dsw-alias-bg-layer-2`: cards, callouts, and code panes.
- `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`, and `--dsw-alias-label-tertiary`: text hierarchy.
- `--dsw-alias-border-l2`: structural lines and controls.
- `--dsw-alias-state-*`: review, success, warning, and error states.

### Named Rules

**The One Action Rule.** Use indigo for the action that moves the task forward; keep supporting controls neutral.

## Typography

**Display Font:** System sans (`ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`)

**Body Font:** The same system sans stack.

**Label/Mono Font:** System sans for labels; `ui-monospace, SFMono-Regular, Consolas, monospace` for digests, IDs, and file content.

**Character:** Neutral, compact, and highly legible. Weight and color establish hierarchy instead of ornamental type.

### Hierarchy

- **Display** (760, `2.2rem`, `1.08`): Hero promise.
- **Headline** (700–760, `1.12–1.2rem`): Panel and section headings.
- **Title** (750, `0.94rem`): Next action and task identity.
- **Body** (400, `15px`, `1.5`): Interface copy; paragraphs cap at 62–76ch.
- **Label** (700, `0.7–0.8rem`, tracked when uppercase): Fields, states, and metadata.

## Layout

The route fills the existing AppFrame center column and owns one scroll container. Its centered content caps at 1180px with 28px side gutters. The masthead uses a 1.15fr/0.85fr split; the workspace uses a main column and a narrower setup/history column. At 900px the columns stack; at 640px fields and before/after panes stack, gutters shrink, and actions become full-width.

The task card is the repeating unit below the hero. Its four-step progress strip, next-action callout, status badge, and exact review panes keep the current decision visible without hiding history.

## Elevation & Depth

Depth comes from DSH tonal layers and thin borders. The shell owns navigation elevation; Software Factory cards use the shared soft elevation token when available.

## Shapes

Controls use gently curved 9px corners; cards and panels use 12–14px corners; status pills use a full 999px radius. Borders remain visible and cool gray. Diff and output panes retain their rectangular reading area inside the card instead of becoming decorative tiles.

## Components

### Buttons

- **Shape:** Compact 9px radius with 0.68rem × 0.92rem padding.
- **Primary:** Indigo background and white text for the next irreversible or advancing action.
- **Hover / Focus:** Darker indigo on hover; a 3px pale-indigo focus ring with a 2px offset.
- **Secondary / Danger:** White neutral controls for setup and cancel; danger uses the red semantic border and text.

### Cards / Containers

- **Corner Style:** 12–14px radius with a 1px structural line.
- **Background:** White for work surfaces; quiet surface for next-action callouts.
- **Shadow Strategy:** No card shadow; use tonal layering and borders.
- **Internal Padding:** 1.05–1.45rem for primary surfaces and 1rem for secondary disclosures.

### Inputs / Fields

- **Style:** Full-width white fields, 1px strong line, 9px radius, and 0.72rem × 0.8rem padding.
- **Focus:** Pale-indigo 3px outline with a 2px offset.
- **Error / Disabled:** Red semantic notice for errors; disabled controls reduce opacity and keep their layout.

### Navigation

The shell owns the wordmark, navigation, active route, and local status. Software Factory contributes one normal sidebar link and a `Ctrl+Shift+T` shortcut. The route does not add a duplicate top bar.

### Task Card

The task card makes the next decision explicit: plain-language status, bounded instruction text, four-step progress, one next-action callout, collapsible output, and a digest-bound before/after review. The DOM is preserved during polling so open disclosures and scroll positions survive updates.

## Do's and Don'ts

### Do:

- **Do** keep the current task action visible without requiring a hidden menu.
- **Do** reserve indigo for the active path and primary action.
- **Do** show exact file content in readable, scrollable monospace panes.
- **Do** keep keyboard focus rings visible and controls native.
- **Do** stack the decision layout before content becomes cramped.

### Don't:

- **Don't** turn Software Factory into a second chat shell or executor console.
- **Don't** imply that execution changed the original before Apply succeeds.
- **Don't** replace exact paths, digests, or file content with vague summaries.
- **Don't** use decorative gradients, large shadows, or motion that obscures state.
- **Don't** hide failure and interruption states behind a generic completion label.
