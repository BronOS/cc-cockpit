---
worth: yes
where: src/shared/tab-groups.ts, main/tabs/, src/renderer/tabs/ (strip, switcher, SplitArea), cockpit.sessions, bronos.team
added: 2026-11-27
---
# One grouping concept: a group is one strip tab (replaces split's strip segment; no separate "tucked" tabs)

Oleg's idea (2026-11-27). A team run fills the strip with member tabs the person never clicks, and a split group shows
every member as its own tab. Needs a design session (core feature) before code.

## The model (agreed 2026-11-27)

- A **group** is one strip tab. It has members; its body shows some of them: one shown fills the body, two or more are a
  split. The rest are in the group's list: a badge on the strip tab (`Lead ▾ 5`) that opens it.
- A plain tab is a group of one (no badge).
- Picking a member from the list shows it **in the group's body**, replacing what was shown (the tab reads
  `Lead ▾ 5 · dev-1`); "Show beside" adds it as a split pane. The strip never grows (Oleg chose this, option A, over
  giving a shown member its own strip tab).
- ✕ on a member's pane hides it into the list. A real close means removing the tab from the group first (Oleg: "untuck
  first. While tab is tucked, the close button only hiding").
- Ctrl+Tab and the Sessions list show the group with its members under it.
- A member that is waiting or needs permission shows on the group's tab by shape or icon (`▾ 5 !`), not colour alone,
  even while hidden; enforced by core.
- The person can group, show, hide and remove any tab. A plugin can open a **new** tab into a group (like `beside`) but
  never move an already-opened tab or change what is shown (Oleg: "plugin can open new tucked tab but can not tuck
  already opened").
- Teams stop using split (Oleg: split for teams "looks not good, it doesn't have enough space and it has limitations
  what is absolutely unnecessary"): bronos.team opens members hidden in the lead's group; the Team panel's member click
  shows that member. Split stays for its own use cases, under the same group tab.

## Open for the design

- How a tab joins a group by hand (drag onto a tab, a menu) and how "Remove from group" places it.
- What is per view (shown members, zoom, focus are per view today in `TabGroups`) and what is the group's (membership).
- Guests and browser views: what a guest sees of hidden members.
- Migrating saved split groups and the `groups.*` channels; `beside` semantics for plugins.
- Group name: the first member's (the lead's) title, or the person's name for it.
