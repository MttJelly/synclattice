# Make local history a clear ChatSwitch sharing workflow

Written against: 84e10832b19584d76a77ab52685085622e6e4d2b

## Evidence chain

- Surface: `src/renderer/index.html` local history overlay and its runtime content from `src/renderer/app.js`, rendered in `qa/multi-window-artifacts/vue-renderer-local-history.png`
- Problem: the surface describes itself as read-only and ends at preview, while the user guide and product positioning say a local Codex or Claude conversation can be copied into ChatSwitch for cross-model continuation. There is no visible copy command or import state in the preview.
- Design evidence: `docs/USER_GUIDE.zh-CN.md` section 11 explicitly instructs users to copy/import a selected local conversation; `src/renderer/index.html` currently says messages only display in the preview and `renderLocalHistoryPreview` creates only metadata and messages. The rendered three-pane browser leaves the preview heading as metadata-only even though this is the point where the selected source and target action are known.
- Owner: `src/renderer/index.html`, `src/renderer/app.js`, and the local-history rules in `src/renderer/styles.css`
- Scope and affected surfaces: local history dialog at desktop and compact widths, selected-conversation preview, import progress/success/error states, and the main conversation list after import
- Uncertainty: none for the command location; runtime validation is required for long titles and compact widths.

## Design decision

Turn the existing three-pane browser into a source-to-ChatSwitch workflow without weakening its read-only boundary. Keep source navigation and preview unchanged, then place one compact primary command in the selected preview heading: “复制到 ChatSwitch”. Pair it with an inline status region that explains the private-copy result. The copy command must never imply that the source file is moved or synchronized, and duplicate imports must resolve to the existing ChatSwitch copy.

## Reuse

- Existing `.primary-command`, `.secondary-command`, `.provider-error`, `.local-history-preview-heading`, and `.local-history-badges`
- Existing native button and `aria-live` status patterns
- Exemplar: `src/renderer/index.html` local-provider import toolbar, which keeps a read-only discovery surface and requires an explicit import command

No new interactive primitive is required. The existing native command and inline status patterns express the workflow.

## Changes

1. `src/renderer/app.js`
   - Change: add the selected-conversation copy command and inline progress/result state to the preview heading; after a successful copy, refresh the ChatSwitch conversation list and open the copied thread when a provider is connected.
   - Preserve: source browsing, search, preview parsing, source-file immutability, current dialog close behavior, and all existing conversation/model actions.
   - Verify: the command is available only for a loaded conversation, disables while running, reports errors beside the command, and repeated copy opens the existing copy instead of creating duplicates.

2. `src/renderer/styles.css`
   - Change: make the preview heading a compact metadata/action layout, keep long titles and paths truncatable, and stack actions cleanly at narrow widths.
   - Preserve: the current three-pane desktop hierarchy and full-height message preview.
   - Verify: no overlap or horizontal overflow at 1200x800 and 900x640; the action remains visible and keyboard focus is clear.

3. `src/renderer/index.html` and generated `src/renderer/vue-render.generated.js`
   - Change: update local-history explanatory copy to distinguish read-only source access from an explicit private copy.
   - Preserve: all IDs, source/list/preview containers, and dialog semantics.
   - Verify: Vue generated output remains synchronized.

## Scope

- Inherit: Codex CLI, Codex App, and Claude Code sources exposed by the local-history reader.
- Verify: empty, loading, selected, importing, imported, duplicate, and error states.
- Exclude: reverse synchronization to source clients, WebDAV conversation synchronization, original application files, source JSONL mutation, credentials, packaging, publishing, and release metadata.

## Validation

- Product: select a fixture Codex/Claude conversation, copy it into an isolated ChatSwitch profile, verify its messages and reasoning summary, repeat the action, then continue through another provider branch.
- Interface: inspect the local-history dialog at desktop and compact widths with a long title/path and confirm command/status visibility, focus, contrast, truncation, and no overlap.
- System: confirm the action reuses the existing primary command and inline status patterns and does not add a second dialog or card system.
- Repository: `npm run build:renderer && npm run check && npm run test:unit && npm run test:vue-ui` -> generated renderer is current and all isolated tests pass.

## Stop conditions

- Stop if implementation would require writing to Codex/Claude source files, replacing an original thread ID, or weakening existing cross-model continuation behavior.

## Design documentation

- After acceptance and validation: correct section 11 wording only if implementation behavior differs from the existing documented copy/import promise.
