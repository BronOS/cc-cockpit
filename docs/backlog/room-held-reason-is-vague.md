---
worth: yes
where: src/cli/room-format.ts:37
added: 2026-11-19
---
# a held room message says "it is busy" for a tab that is idle and will never take it

`ccc room send` explains a hold with `HELD_WHY`; `not-waiting` prints "it is busy" for every status that is not
*waiting for input*. That includes `idle`: after a compaction at the prompt the tab sits `idle`, no `idle_prompt`
follows, and nothing delivers the message until someone types in that tab (`compact-at-prompt-leaves-tab-idle.md`).
In the guest-invite team run (2026-11-19) three devs sat about 30 min like that while the lead read "held (it is
busy)" and waited; Oleg noticed first. The sender cannot tell "busy, it will come" from "stuck, someone must act".

Fix: split `not-waiting` by the recipient's status. Busy keeps "it is busy". `idle` says it will not be delivered by
itself and how to unstick it (type `ccc room read` and Enter in that tab, or the count badge). `ccc room status`
could mark such a member too. Fixing the compaction item removes the main cause but not the need for honest text.
