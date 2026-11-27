---
worth: yes
where: src/renderer/tabs/ (strip, switcher), main/tabs/, cockpit.sessions, bronos.team
added: 2026-11-27
---
# Tucked tabs: hide tabs under a parent tab, one strip tab per split group

Oleg's idea (2026-11-27). A team run fills the strip with member tabs the person never clicks, and a split group
shows every member as its own tab. Needs a design session (core feature) before code.

## The idea

- A tab can be *tucked* under a parent tab. The parent's strip tab shows a count badge (`Lead ▾ 5`); clicking it lists
  the tucked tabs (status, name), and a row shows that tab.
- Ctrl+Tab and the Sessions list group tucked tabs under their parent.
- A tucked tab that is waiting or needs permission must show on the parent's badge by shape or icon, not colour alone
  (see memory close-shades-hard-to-see); enforced by core, not left to plugins.

## Decided (Oleg's words)

1. Where a shown tucked tab appears: "next tab to the lead/main (same as now marked that this is a group). User can
   close it and it will hidden again".
2. Who tucks: "User can always, plugin can open new tucked tab but can not tuck already opened".
3. Split groups: "at the beginning i thought that it will be a good idea to use split for teams, but after several team
   runs i found it is not good. It looks not good, it doesn't have enough space and it has limitations what is
   absolutely unnecessary. In other hand split is a very good feature, but for different use-cases. Then split tabs also
   has to be grouped into one main tab, because once you have several tabs in split mode anyway you will look on it on
   one single screen/view, i mean you are clicking on a main tab and see all of them at once."

So: teams stop using split (bronos.team opens members tucked under the lead, the Team panel's member click shows the
tab), and a split group becomes one strip tab (today `strip-groups.ts` draws a bracketed segment with every member's tab).

## Open for the design

- The ✕ on a shown tucked tab tucks it again; where the real close lives (tab menu, or untuck first).
- A tab the person tucks with no natural parent: under the tab it was opened from, or a project-level `⋯ N` badge.
- One split-group strip tab: how a member's status, flag and needs-you show on it; how a member leaves the group.
- Plugin API: `ctx.sessions.open*({ tucked: { under } })` or similar; the parent must be the plugin's own or a tab of
  the window (as `beside`); the "never tuck an opened tab" rule enforced in main.
- Guests and browser views: tucked is per tab (shared) or per view.
