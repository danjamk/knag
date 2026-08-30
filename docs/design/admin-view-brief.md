# Brief — the people pane

**For:** the Claude Design session, which owns every visual decision in knag.
**Status:** open. **Built plain and shipped in 1.9.0 (#232)** ahead of the ruling, as the
phase plan said it would be — it has one viewer, and that viewer deployed it. Everything
below is a decision to overrule, not a blank to fill.

Answer with decisions, not options. Where this brief is already wrong, say so.

---

## 1. What it is

The operator's one screen about other people. It answers a single question — *is this
still free?* — and carries the four verbs the operator has: **invite, change email,
revoke, delete** ([ADR-008](../adr/ADR-008-email-login.md) §11, §4, §12).

It is reached from the sheet: a new group, `hosting`, under `you`, with one row,
`people`, showing the live count and a chevron. The group exists only for the operator —
a member never sees it, and the routes behind it answer a member with the 404 a missing
route gets. Tapping the row swaps to a pane, like `devices` (#149).

## 2. What is on it, today

**Head:** `people · 3 of 25`. The cap is a constant in the code
(`MAX_USERS = 25`, spec §14.4's arithmetic) and the head is the only place it is said.

**The table.** One row per person, the operator first, in the machine voice throughout
— DM Mono, `--size-micro`, `--dim`, because every value is something the server counted
and nobody typed. Columns, in order:

| | |
|---|---|
| `who` | the address, in ink; amber on the operator's own row; struck through when revoked |
| `seen` | the newest device's last-seen, as a short date; `never`; or `revoked` |
| `dev` | live sessions — the multiplier §14.4 cares about |
| `pages` | live pages |
| `sits` | sittings in thirty days — `revisions` rows by a person or their agent |
| `agent` | how many of those were the agent's |
| `wipes` | thirty days |
| `done` | items cleared, thirty days |
| (actions) | `revoke`, or `delete` on a revoked row; `you` on the operator's |

A totals row (`all`) under a hairline. The table **scrolls sideways inside the pane**
rather than folding: eight numeric columns on a 390px phone do not fold into anything
readable, and I chose a scroll over dropping columns because the columns are the point.

**Under the table:** one machine-voice note explaining sitting/agent/revoke/delete/tap
the address, and the pane's error line (amber, the same one manage-pages uses).

**Foot (`.pane-actions`):** the invite — an email field and an `invite` button, the same
shape as manage-pages' `new page`.

**The verbs.** Revoke and delete are per-row buttons in the device-revoke style (44px,
amber, hairline) and **confirm by repetition** — a first tap arms the control, its label
becomes `again to confirm`, and it disarms on its own after four seconds. Same rule as
the whole-page wipe; no dialog anywhere. Change email is **tap the address**: it becomes
a field, blur or Enter commits, a fresh invite mail goes to the new address.

🔴 **No page content, ever.** The one string per row is an address. This is not a
layout constraint to be traded against; it is the whole reason the table may exist.

## 3. What I want ruled

1. **Is it a table?** It is the obvious answer and it may be the wrong one. Nine columns
   of numbers is a spreadsheet on a phone, and this product has never shown one. The
   alternative I can see is a list — one card per person in the devices-list shape, with
   the numbers as a second line in the machine voice — and totals as a line, not a row.
   The question is whether the thing that answers *is this still free?* is a comparison
   across people (a table) or a glance at each (a list). I lean table; argue.
2. **The sideways scroll.** If the table stands, does it scroll, fold, or lose columns
   below some width? Which columns are load-bearing on a phone: I would keep `who`,
   `seen`, `dev`, `pages` and let the thirty-day counts go to a wider screen.
3. **The words.** `hosting` and `people` for the group and the row; `sits`, `dev`,
   `done` as column heads; `again to confirm` armed. All of these are mine and none are
   from the brand. `seen` versus `last seen`; `sits` is ugly and `sittings` is wide.
4. **The address as a control.** Tapping text to edit it has no precedent in knag except
   the manage-pages rename, which is already a field. Should the address be a field at
   rest, like a page name is? Or a `change` button beside `revoke`, which costs a column?
5. **The operator's own row.** It shows `you` where the verbs would be, in amber on
   `who`. Should it be in the table at all, or is it a line above it (`you · 2 devices ·
   4 pages`) and the table is everyone else?
6. **Revoked rows.** Struck through, `revoked` in the `seen` column, `delete` as the
   verb. Should a revoked person stay in the table at all, or move below a hairline?
7. **The empty state.** One row (the operator) and the invite field. Is there a line
   that says what this is for, the first time — or is the field enough, per §7's rule
   that the app carries no onboarding?

## 4. What is not being asked

- A chart. The table's whole job is to be read in two seconds.
- Request counts. Deliberately not stored (ADR-008 §11); the Cloudflare dashboard has
  the total and `dev` is the multiplier.
- Anything a member sees. There is nothing; the group is hidden and the routes 404.
- Colour. Amber is the only one, and the revoke/delete controls already use it the way
  device-revoke and the page-delete control do. Never red.

## 5. Where it lives in the code

- Markup and styles: `public/index.html`, the `[data-people-pane]` block and the
  `.people` rules beside `.manage`.
- Behaviour: `client/src/app.ts`, the *People* section.
- The routes: `worker/src/admin.ts`; the queries in `worker/src/store.ts`
  (`listUserStats`).
- The mail: `inviteMail` in `worker/src/mail.ts` — the one piece of onboarding text the
  product has, per ADR-008 §3. Not part of this brief, but the pane sends it.
