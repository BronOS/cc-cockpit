---
worth: yes
where: src/main/sessions/status-reducer.ts:294
added: 2026-11-19
---
# a compaction at the prompt leaves the tab idle, so queued texts and room messages never arrive

Seen in the guest-invite team run (2026-11-19). Three member tabs (dev-kira, dev-victor, dev-boris) had finished their
turns and sat at the prompt (`waiting`). Their sessions then compacted outside a turn: victor's turn ended at
16:23Z, and the transcript has `compact_boundary` at 17:17:06Z. boris compacted in the same second, kira at 17:17:54Z;
what triggered it is unknown, since nobody typed there. Claude Code fired `SessionStart` with `source: "compact"`, and
the reducer maps that to the non-sendable `idle` whenever the tab is not `working`. No `idle_prompt` Notification
followed in 30+ minutes, so the send gate never delivered (`ccc room send` answered "held (it is busy)") and no `Stop`
came either. The tabs sat with 3, 3 and 2 held room messages until the person typed a prompt in each one.

The reducer's comment already names the open question ("where it lands relative to the prompt is not established").
This incident establishes it for compaction from `waiting`: the session was at its prompt before and after. Fix: a
`compact` SessionStart from `waiting` keeps `waiting`, like `compactMidTurn` keeps `working`. Other sources and other
statuses stay `idle`.

Test it in the reducer's unit tests, plus a send-gate case: a text queued while the tab is `waiting` is delivered after a
compact. Check whether a manual `/compact` typed at the prompt also lands at the prompt; the `typed` and draft bits
already cover that case.
