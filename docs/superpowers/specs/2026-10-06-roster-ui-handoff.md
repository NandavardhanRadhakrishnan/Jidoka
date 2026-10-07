# Roster UI handoff (from Claude Design)

Copied from the Claude Design project `Jidoka` (`f9eff891-e467-4c9a-be09-0e44d889c08d`), `design_handoff_roster/README.md`, synced against main on 2026-10-06. The clickable prototype is `design_handoff_roster/Jidoka.dc.html` in that project (it only renders inside the project). The backend spec is `2026-10-06-roster-design.md`; where the two differ, that spec's "UI" section wins. Its two deviations:

- **Hover styles follow the repo:** row and ghost hovers use `color-mix(in srgb, var(--color-text) 6%, transparent)` like `.type-row` and `.pane-row`, not the ramp tokens this handoff names. `.participant-pick` copies `.candidate-btn` and keeps `accent-100`.
- **Domain suggestion notice** (not in this handoff): see the spec.

---

## Overview
Adds a roster of the people work involves: teammates in Your org, and outside parties grouped into orgs. It has two surfaces:
- **People**, a new screen in the left rail between "Types & rules" and "Extensions".
- **People**, a new section in the task drawer listing who is on the task.

This is groundwork for a later "waiting on <person>" feature. Waiting itself is not designed here, but space is reserved for it (see §5).

The prototype uses inline styles because of how it's built. **The implementation must use classes only, with no inline `style`**; the class list is in §6.

## Fidelity
High fidelity. Use the Modernist tokens already in `modernist.css`. Archivo at weights 400, 600 and 800 only. All radii are 0.

## Concepts (as the UI presents them)
- **Org**: a relationship group seen from the user's org, not a legal company. Exactly one org is flagged Your org. It always exists, can be renamed and can't be deleted. An org has zero or more email domains. Domains are only a hint for attributing unknown senders.
- **Person**: a display name, an optional org (always set by hand, never derived from a domain), and zero or more identities written `namespace:value` (`email:bob@acme.test`, `github:bobsmith`). "Me" is a person in Your org. It always exists, can be renamed, can't be deleted, and gains identities when extensions connect.
- **Participant**: an identity the source reported on a task, with a role (`from`, `to`, `cc`, `author`, `assignee`, `commenter`), or a roster person the user tagged by hand.

## Behavior spec

### 1. Rail and screen shell (`App.tsx`)
- Add `{ key: "people", label: "People", icon: "users" }` to `NAV`, between `types` and `extensions`. Add `people: "People"` to `SCREEN_TITLE`.
- Header subtitle (`.app-header .sub`): "N orgs · M people", singular when the count is 1.
- Render `<People />` from the new `src/client/People.tsx`.

### 2. People screen (`People.tsx`)
Two columns: `.people-screen` is a grid, `280px minmax(0,1fr)`, the same as `.types-screen`.

**Left column, the org list (`.org-list`)**
- Order: Your org pinned first, then the other orgs sorted alphabetically (`localeCompare`), then a **No org** group.
- Org row (`.org-row`, same metrics as `.type-row`):
  - Line 1: name (heading, 800, 14px). On Your org only, a `.yours-badge` reading "your org". People count, right-aligned (mono, 10.5px, `neutral-600`).
  - Line 2: domains joined with " · " (mono, 11px, `neutral-600`), or "no domains".
  - `.on` (accent left border, surface background) marks the active group: the selected org, or the selected person's org.
- No org row (`.org-row.no-org`): has a top divider, the name in `neutral-700`, and a count.
- Below the list: `[+ Add org]` (`.btn-secondary`, small). It creates "New org" with `POST /api/orgs` and selects it.

**Right column, org selected**
- Head (`.roster-head`):
  - Name as an editable heading input (`.input.title-input`): 22px, 800, transparent border at rest, divider border on hover, accent border and surface fill on focus. Save on blur or Enter with `PATCH /api/orgs/:id`.
  - `.yours-badge` on Your org.
  - `[Delete org]` (ghost, `accent-700`, right-aligned) on every org except Your org. `title`: "Its people move to No org". It calls `DELETE /api/orgs/:id`.
- One line of description, 13px, `neutral-800`:
  - Your org: "The people you work with. On a task, anyone in this org is shown as one of yours."
  - Others: "An outside party you work with. Group people by relationship, not by legal company."
- **Email domains** (`h6`):
  - Chips (`.roster-chip`, mono), each with an `x` remove button (`.roster-chip-remove`, 22×22px). Remove calls `DELETE /api/orgs/:id/domains/:domain`.
  - Add row (`.roster-add-row`): a mono `.input` ("add a domain, e.g. acme.test") and `[Add]` (`.btn-secondary`, small). Enter also submits. It calls `POST /api/orgs/:id/domains`.
  - Before calling the API, normalize the value: lowercase, trim, strip a leading `@`.
  - Show 409 messages and local validation as `.error-text` under the row. Clear the error on the next keystroke.
  - Fixed footnote, 11px, `neutral-600`: "Domains only suggest this org for unknown senders. A person's org is always set on the person."
  - Empty state:
    - Your org: "No domains yet. Add your company's email domain so new senders from it are suggested for this org."
    - Others: "No domains. That's fine; people can still be added to this org by hand."
- **People** (`h6` plus a mono count):
  - Rows (`.roster-person-row`, full-width buttons with a bottom divider): name (800, 13.5px), `.me-badge` on Me, the first identity plus "+N" (mono, 11px, `neutral-600`, ellipsis), and `chevron-right`. Me sorts first, then alphabetical.
  - Clicking a row selects that person.
  - `[Add person]` (`.btn-secondary`, small, `user-plus` icon) turns into an inline row with a name `.input`, `[Add]` and `[Cancel]`. Add calls `POST /api/people` with `{ name, orgId }` and selects the new person.
  - Empty state: "Nobody in this org yet."
- **Fresh install** (exactly one org and one person): show `.roster-intro` above the domains: "Your roster starts with your org and you. People are added as they turn up on tasks, or by hand here."

**Right column, No org selected**
- Static heading "No org", then the description "People who don't belong to any org, such as a freelancer."
- People list and Add person as above. Add person sends `orgId: null`.
- Empty state: "Nobody here."

**Right column, person selected**
- Back link (ghost, `neutral-700`, `arrow-left`) labelled with the person's org name, or "No org". It returns to that group.
- Head: display name as `.title-input` (saved with `PATCH /api/people/:id`), `.me-badge` on Me, and `[Delete person]` (ghost, `accent-700`) on everyone except Me.
- Me only: "This is you. Connecting an extension adds your identity on that source automatically."
- **Org**: a `SelectTrigger` with label "org". Options: orgs in list order, then "No org". It saves with `PATCH /api/people/:id { orgId }`. Next to it, 11px `neutral-600`: "Set by hand. Email domains never move a person between orgs."
- **Identities**:
  - Chips and an add row like the domains section. Placeholder: "email:name@domain or github:login". It calls `POST /api/people/:id/identities`, and remove calls `DELETE /api/people/:id/identities/:identity`.
  - Normalize before calling the API: lowercase the namespace, and lowercase the whole value for `email:`.
  - Empty state:
    - Me: "No identities yet. They're added when you connect an extension."
    - Others: "No identities. That's fine for someone you only deal with by phone."

**Inline conflict errors.** Show the server's 409 message verbatim. The client also pre-checks against the loaded roster and uses the same strings:

| Case | Message |
|---|---|
| Identity owned by someone else | `email:bob@acme.test belongs to Bob Smith` |
| Identity already on this person | `email:bob@acme.test is already on Bob Smith` |
| Domain on another org | `broker.test is already on Supplier Ltd` |
| Public webmail domain | `gmail.com is a public email domain` |
| Malformed identity | `Use namespace:value, e.g. email:bob@acme.test` |
| Malformed domain | `Enter a domain like acme.test` |

### 3. Task drawer, People section (`TaskDetail.tsx`)
**Placement:** directly after "Merged from" and before "Task content".

**Section head** (`.drawer-section-head`): `h6` "People", a mono count, and a right-aligned slot (`.drawer-section-head .slot`) holding `[Add person]` (ghost, 11px, `user-plus`). The slot is where the future "waiting on" chip goes (§5).

**List** (`.participant-list`: divider border, surface fill). Each row (`.participant-row`, min-height 36px, `padding: 6px 10px`) starts with the role (mono caps, 9.5px, `neutral-600`, 76px column). Hand-added rows show the role "added".

Known participant, in this order:
1. Name (800, 13px).
2. `.me-badge` if it's Me.
3. Org badge.
4. The identity that matched (mono, 11px, `neutral-600`, flex 1, ellipsis). Hand-added rows show the person's first identity.
5. `[Remove]` (ghost, 11px) on hand-added rows only. It calls `DELETE /api/tasks/:id/participants/:pid`.

**Org badges** carry the Your-org and external distinction:
- `.org-badge.org-yours`: solid `neutral-900` with `--color-bg` text. Your org.
- `.org-badge.org-external`: `accent-100` fill with `accent-800` text. Any other org.
- `.org-badge.org-none`: transparent, divider border, `neutral-600` text, reading "no org".

Unknown identity:
- The raw identity (mono, 11.5px, `--color-text`), then "as <source display name>" (11px, `neutral-600`).
- `[Add to roster]` (ghost, 11px, `user-plus`) opens `.participant-add-form` inline under the row:
  - **Display name**: prefilled with the source's display name.
  - **Identity**: mono, prefilled with the raw identity. Editable.
  - **Org**: a `SelectTrigger` prefilled with the org whose domains contain the email's domain. Next to it: "Guessed from <domain>", or "No org has <domain>" when nothing matched. The note clears once the user changes the org.
  - `[Add to roster]` (`.btn-secondary`, small, disabled while the name is empty) and `[Cancel]`.
- Submitting calls `POST /api/tasks/:id/participants { name, identity?, orgId? }`, then reloads participants and the roster. The row turns into a known participant.
- A 409 shows as `.error-text` in the form.

**Add person picker** (replaces the head button while open):
- An `.input` with autofocus and the placeholder "Find someone in the roster, or type a new name".
- Up to 6 matches (`.participant-pick`): name, `.me-badge`, org badge, first identity or "no identities". People already on the task are excluded. Picking one calls `POST /api/tasks/:id/participants { personId }`.
- If the typed text exactly matches no person's name (case-insensitive), add a dashed `.participant-pick.create` row: "Create “Dana”", with the subline "Adds them to the roster with no org and no identities." It calls `POST /api/tasks/:id/participants { name }`.
- When there is nothing to show: "Everyone in the roster is already on this task."
- `[Cancel]` (ghost) closes the picker.

**Empty state** (no participants): "The source didn't report anyone on this item."

### 4. States the client must handle
- When the roster changes, re-resolve the drawer rows.
- Source-reported rows never get Remove. Only rows the user added by hand do.
- Deleting an org moves its people to No org.

### 5. Room for "waiting on <person>" (not built)
- **Task card:** the chip goes first in `.meta-row .meta-badges`, before priority and deadline.
- **Drawer:** the chip goes in `.drawer-section-head .slot` of the People section, left of Add person.
- Reuse `.org-badge` sizing so the chip lines up with the existing badges.

## 6. New classes for `src/client/modernist.css`
All radii are 0.
```
.people-screen            grid; 280px minmax(0,1fr); height 100%; min-height 0
.org-list                 border-right 2px divider; padding 14px 0 24px; overflow-y auto; flex column
.org-row                  as .type-row; .on accent left border + surface
.org-row .domains         mono 11px neutral-600
.org-row.no-org           border-top 1px divider; margin-top 6px; name neutral-700
.yours-badge              mono 9.5px caps, letter-spacing .04em, padding 0 6px, line-height 16px; bg neutral-900; color bg
.me-badge                 same metrics; transparent; 1px accent-700 border; color accent-700
.org-badge                same metrics; white-space nowrap; flex-shrink 0
.org-badge.org-yours      bg neutral-900; color bg
.org-badge.org-external   bg accent-100; color accent-800
.org-badge.org-none       transparent; 1px divider border; color neutral-600
.roster-detail            padding 18px 20px 48px; overflow-y auto
.roster-head              flex; align center; gap 12px; wrap
.title-input              .input variant: heading 800 22px, -0.015em; transparent bg + border; padding 2px 6px; margin-left -7px; max-width 440px
                          :hover border divider; :focus-visible border accent, bg surface
.roster-section           flex column; gap 10px; margin-top 22px
.roster-chip              mono 11.5px; inline-flex; gap 2px; 1px divider border; surface bg; padding 1px 1px 1px 8px
.roster-chip-remove       22×22; transparent; neutral-600; :hover accent tint, color accent-700
.roster-add-row           flex; gap 8px; max-width 440px; input min-height 32px, 12.5px
.roster-note              11px neutral-600
.roster-intro             13px neutral-800; padding 10px 12px; 1px divider border; surface bg
.roster-person-row        flex; gap 8px; full width; border-bottom 1px divider; padding 9px 4px
.drawer-section-head      flex; align center; gap 8px; min-height 24px; .slot margin-left auto, flex, gap 8px
.participant-list         1px divider border; surface bg; flex column
.participant-row          flex; align center; gap 8px; padding 6px 10px; min-height 36px; + .participant-row border-top 1px divider
.participant-row .role    mono 9.5px caps .1em; neutral-600; width 76px; flex none
.participant-row .name    heading 800 13px; nowrap
.participant-row .ident   mono 11px neutral-600; flex 1; ellipsis
.participant-add-form     flex column; gap 10px; padding 10px 12px 12px; border-top 1px divider; bg var(--color-bg)
.participant-pick         as .candidate-btn but row layout (align center, gap 8px, padding 7px 9px)
.participant-pick.create  border-style dashed; transparent bg; column layout
```

## Acceptance checks
1. The rail shows People between "Types & rules" and "Extensions". The header subtitle reads "N orgs · M people".
2. The org list is ordered Your org first, then the others alphabetically, then No org. Counts and domains match the roster.
3. Adding `gmail.com` to any org shows "gmail.com is a public email domain". Adding a domain that's on another org shows "<domain> is already on <org>". Neither changes the roster.
4. Adding an identity owned by someone else shows "<identity> belongs to <name>" and doesn't change the roster.
5. Your org and Me can be renamed but have no delete action. Every other org and person has one.
6. Changing a person's org with the SelectTrigger moves them in the left-column counts. Adding a domain never changes anyone's org by itself.
7. On a fresh install, the list shows only "My org" (your org) and No org. My org shows the intro note, the empty-domains note and a single "Me" row. Me shows the "No identities yet…" note.
8. In the drawer, People sits above Task content and shows known participants with org badges, Me with the "me" marker, unknown identities with Add to roster, and hand-added people with Remove.
9. Add to roster on an unknown row opens a form prefilled with the source name, the identity, and the guessed org with "Guessed from <domain>". Submitting turns the row known without adding a second row.
10. Add person lists only roster people who aren't already on the task. Typing an existing name offers no Create row; typing a new one offers "Create “<name>”".
11. Source-reported rows never show Remove.
12. Nothing on either surface opens a new tab or window.
13. No inline `style` attributes in `People.tsx` or the new drawer code. Only Archivo 400, 600 and 800 are used.

## Assets
New Lucide icons for `src/client/icons.tsx`: `users`, `user-plus`, `x`, `chevron-right`, `arrow-left`. `plus` and `chevron-down` already exist.
