---
worth: yes
where: src/cli/args.ts:727
added: 2026-11-19
---
# room docs: no append, and `doc put -` cannot be fed from Code Mode's REPL

Seen by several members of the guest-invite team run (2026-11-19):
- **No append.** A log-style doc (a member's running notes, the lead's verify list) is get, edit, put each time; two
  writers race and the last one wins. An `append` (main serialises writes per room already) would fit logs.
- **`doc put -` from the REPL.** A Code Mode tab has only REPL and Poll; a `ccc room doc put <path> -` run from the
  REPL has no stdin and waits the full 40 s (`stdin was not closed within 40 s`, exit 124). Members worked around it
  with a scratch file and `< file`. A `--file <path>` form (or `ccc` noticing a TTY-less, empty stdin sooner) would
  remove the trap.
- **A trailing newline, unconfirmed.** Once a patch published as a doc and read back failed `git apply` as "corrupt"
  for a missing final newline (run notes, 03c). The CLI keeps a doc exact both ways (`client.ts` "a doc is kept
  exact"), so the loss may come from the reader (a REPL capturing output); reproduce before fixing anything.
