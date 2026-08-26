# Give ChatSwitch a semantic, conversation-first color system

Written against: 84e10832b19584d76a77ab52685085622e6e4d2b

## Evidence chain

- Surface: `src/renderer/index.html` core workspace, local-history workflow, connection manager, sync, backup, settings, and extensions dialogs; rendered in `qa/multi-window-artifacts/vue-renderer-desktop.png`, `vue-renderer-conversation.png`, `vue-renderer-local-history.png`, and `vue-renderer-sync.png`
- Problem: the current effective theme uses green-tinted values for the canvas, sidebar, panels, selection, composer, reasoning, and most commands. Hierarchy is therefore carried mostly by brightness, while informational sync state and source-to-private-copy state look like generic settings.
- Design evidence: the final theme owner in `src/renderer/styles.css` maps `--bg`, `--surface-2`, sidebar, chat, user messages, reasoning, thinking, composer, and dialog chrome to the same green family. The rendered screenshots show this tint across nearly every large surface. Warning and destructive states already have distinct amber and red meanings and must retain them.
- Owner: the final ChatSwitch theme layer in `src/renderer/styles.css`, with existing structure and labels in `src/renderer/index.html`
- Scope and affected surfaces: light and dark core workspace, local-history copy workflow, connection manager, sync, backup, extensions, settings, confirmation, desktop and compact widths
- Uncertainty: Windows display scaling and live content extremes require isolated visual validation.

## Design decision

Move large surfaces to a neutral graphite system and reserve emerald for ChatSwitch identity, selection, and primary commands. Add blue as the informational/synchronization semantic color, keep amber for warning or interrupted states, and keep red for destructive actions only. Increase separation between navigation chrome, reading canvas, raised controls, and modal surfaces without gradients, glow, blur, or decorative cards. In the local-history workflow, use neutral source navigation and an emerald target action so the source-to-private-copy direction is immediately legible.

## Reuse

- Existing CSS variables and native controls: `--bg`, `--surface`, `--surface-2`, `--line`, `--ink`, `--muted`, `--accent`, `--focus`, `--danger`, `.primary-command`, `.secondary-command`, `.dialog-heading`, `.segmented-control`
- Existing semantic surfaces: `.turn-interruption`, `.thinking-indicator`, `.sync-summary`, `.local-history-preview-heading`, `.local-history-import-status`
- Exemplar: the current conversation layout and compact density, which already provide stable widths and clear reading order

No new component primitive is required. Semantic variables can express the decision across existing owners.

## Changes

1. `src/renderer/styles.css`
   - Change: replace the final light/dark theme palette with neutral canvas and chrome tokens; introduce semantic info, warning, success, and danger soft surfaces; retarget workspace, sidebar, selection, messages, composer, dialogs, and utility states to those tokens.
   - Preserve: dimensions, responsive rules, scroll ownership, state selectors, transition limits, queue behavior, thinking height, and all runtime hooks.
   - Verify: large surfaces are neutral, emerald appears only for identity/selection/primary actions, blue identifies sync/information, and warning/destructive meanings remain distinct.

2. `src/renderer/styles.css` local-history and utility dialog rules
   - Change: strengthen source/list/preview separation, make the copy destination visually explicit, and align sync, backup, settings, usage, and extensions surfaces with the same neutral hierarchy.
   - Preserve: three-pane browser, read-only source behavior, private-copy command, forms, tabs, and compact stacking.
   - Verify: local-history selection and copy command remain visible with long titles; dialogs do not become nested card collections.

3. `src/renderer/vue-render.generated.js`
   - Change: regenerate only if source template changes during accessibility corrections.
   - Preserve: Vue mount lifecycle and all existing behavior.
   - Verify: generated renderer remains synchronized.

## Scope

- Inherit: every renderer surface consuming the final variables and shared dialog/control classes.
- Verify: provider, conversation, running, interruption, queue, local-history, sync, backup, usage, settings, extensions, confirmation, light, dark, desktop, and compact states.
- Exclude: provider execution, model reasoning, conversation persistence, WebDAV payload design, original client data, packaging, release metadata, publishing, and the user's active ChatSwitch window.

## Validation

- Product: run the isolated Vue QA profile, import a fixture local conversation, open sync and utility dialogs, and confirm all actions and states still work.
- Interface: compare all 17 screenshots for contrast, semantic color, label fit, focus, overlap, overflow, and dark-theme title-bar controls.
- System: confirm there is one final semantic token owner, no gradient, no large blur, no glow, and no new component system.
- Repository: `npm run build:renderer && npm run check && npm run test:unit && npm run test:vue-ui` -> generated renderer is current, 57 unit tests pass, and isolated visual tests report no error or overlap.

## Stop conditions

- Stop if a visual change would require changing model behavior, source conversation files, the active user window, or a data migration.

## Design documentation

- After acceptance and validation: this plan remains the design record; no release or user-documentation update is required for a theme-only change.
