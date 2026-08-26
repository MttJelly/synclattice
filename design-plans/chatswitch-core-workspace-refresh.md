# Refresh the ChatSwitch core workspace

Written against: 84e10832b19584d76a77ab52685085622e6e4d2b

## Evidence chain

- Surface: `src/renderer/index.html` main desktop workspace, rendered in `qa/multi-window-artifacts/vue-renderer-desktop.png` and `qa/multi-window-artifacts/vue-renderer-conversation.png`
- Problem: the title bar, sidebar, conversation, composer, running/error states, and connection manager use competing accent colors, border weights, densities, and emphasis; the connection manager also gives a long utility list similar weight to the provider selection task.
- Design evidence: `src/renderer/styles.css` is the loaded visual owner and contains multiple later overrides for the same controls; the rendered screenshots show orange, teal, blue, and green acting as primary accents within one task, heavy borders around most regions, a crowded composer footer, and a sparse oversized connection dialog.
- Owner: `src/renderer/styles.css`, with structural ownership in `src/renderer/index.html` and generated Vue composition from `src/renderer/vue-bootstrap.js`
- Scope and affected surfaces: title bar, sidebar, empty/chat workspace, conversation states, composer and queued prompts, provider overlay, shared dialogs, light/dark themes, desktop and compact viewports
- Uncertainty: live content length, Windows display scaling, and keyboard focus behavior require isolated runtime validation.

## Design decision

Unify the core workspace around ChatSwitch's existing deep-green identity: use one teal accent for selection and primary actions, reserve amber/red for warnings and destructive actions, reduce decorative borders and shadows, and establish a stable hierarchy of chrome, navigation, content, and composer. Keep the product dense and operational rather than card-led. Make the connection manager a clear provider-first master-detail surface, with utility actions visually subordinate. Preserve every existing command, state, ID, model control, and data path.

## Reuse

- Existing CSS variables `--bg`, `--surface`, `--surface-2`, `--line`, `--line-strong`, `--ink`, `--muted`, `--subtle`, `--teal`, `--danger`
- Existing native `button`, `input`, `select`, `textarea`, dialog markup, Lucide icons, and Vue custom-element compositions
- Exemplar: the dark conversation surface in `qa/multi-window-artifacts/vue-renderer-conversation.png`, especially its restrained deep-green canvas and unframed message column

No new interaction primitive is required. Existing native controls and dialog ownership can express the decision; styling and small semantic/template corrections are sufficient.

## Changes

1. `src/renderer/styles.css`
   - Change: consolidate the effective theme into a final scoped workspace refresh, normalize color, spacing, radii, shadows, focus rings, control sizes, sidebar density, message rhythm, composer grouping, provider hierarchy, compact behavior, and dark mode; remove large-surface blur effects and non-semantic accent competition.
   - Preserve: all selectors used by runtime state, current responsive breakpoints, visibility classes, scrolling regions, content virtualization, drag-and-drop, queue, streaming, and approval behavior.
   - Verify: desktop and compact screenshots have one primary accent, no overlaps or clipped labels, stable composer dimensions, readable long summaries, and clear warning/destructive states.

2. `src/renderer/index.html`
   - Change: make targeted accessibility corrections to touched controls and tab/dialog states, including complete accessible names and explicit button types where missing; do not restructure runtime-owned containers.
   - Preserve: every existing ID, `data-*` hook, form field name, custom Vue element, label, and command.
   - Verify: icon-only controls have accessible names, tabs and menus expose their state, and form submission behavior is unchanged.

3. `src/renderer/vue-bootstrap.js` and generated `src/renderer/vue-render.generated.js`
   - Change: regenerate the Vue render artifact from the adjusted template and keep the source template synchronized.
   - Preserve: mount lifecycle, native-node adoption, custom component behavior, and event routing.
   - Verify: `npm run build:renderer` produces a clean generated artifact and `npm run check` reports no template drift.

## Scope

- Inherit: all core workspace states and shared overlays that consume the existing renderer stylesheet.
- Verify: empty, conversation, streaming/thinking, queue, attachment, approval, confirmation, provider, local-history, extension, settings, and dark-theme states at desktop and compact widths.
- Exclude: model/provider execution, conversation persistence, local ChatGPT/Codex/Claude data, main-process window lifecycle, original application files, packaging, release metadata, and publication.

## Validation

- Product: open ChatSwitch only through the isolated Vue QA window; select a conversation, type while a turn is represented as running, inspect the queue, open provider selection and confirmation surfaces, and confirm all existing commands remain available without touching the user's current window.
- Interface: inspect desktop, compact, conversation, confirmation, attachment, local-history, provider, and dark screenshots; test long Chinese labels, long reasoning summaries, narrow widths, keyboard focus, reduced motion, overflow, and contrast.
- System: confirm the final rules reuse existing variables and native controls, do not add a second component system, and do not add gradients, glow effects, or large animated blur surfaces.
- Repository: `npm run build:renderer && npm run check && npm run test:unit && npm run test:vue-ui` -> generated renderer is current, syntax/unit checks pass, and isolated Vue UI screenshots complete without failure.

## Stop conditions

- Stop if the requested visual change requires changing renderer behavior, model capability, conversation data, the user's active ChatSwitch window, or original ChatGPT/Codex application files.

## Design documentation

- After acceptance and validation: none; this implementation plan is the scoped design record.
