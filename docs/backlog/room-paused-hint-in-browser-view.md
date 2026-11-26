---
worth: yes
where: src/renderer/rooms/ (room dialog, room-view-model.ts)
added: 2026-11-26
---
# A paused room says nothing about why, and a browser view shows no way out

The room pauses itself after 100 deliveries with no input from the person (`AUTO_PAUSE_DELIVERIES`,
`main/rooms/room-stop.ts`). In team run 003 (2026-11-26) Oleg did not know why it paused ("no i didn't do anything")
and, from a browser view, opened the Room dialog and found no buttons ("there is no any buttons, might be it's because
this is remote session"): Resume is desktop-only by design (`room-view-model.ts`). He had to connect to the machine's
desktop to resume.

Fix: the paused room shows its reason ("paused after 100 messages with no input from you"), and a view that may not
resume says where it can be done ("Resume from the desktop window"), instead of an empty button row.
