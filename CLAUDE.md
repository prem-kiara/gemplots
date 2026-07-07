# Dhanam Plots Platform

You are implementing a specified architecture, not designing one.

**Start here every session:**
1. Read [HANDOVER.md](HANDOVER.md) — especially §4 Invariants (hard constraints, they override
   everything including test expectations and your own judgment).
2. Read [docs/07-build-instructions.md](docs/07-build-instructions.md) §0 (Session Protocol),
   then the brief for the current slice. Work exactly one slice per session, in order.
3. The `docs/` directory is the complete, self-contained source of truth. No external documents
   are needed or authoritative.

**Never:**
- Violate a HANDOVER §4 invariant.
- Use floats for money (integer paise only) or naive timestamps (timestamptz UTC only).
- Confirm a booking from anything other than the signature-verified webhook path.
- Edit an applied migration, enable ORM schema-sync, or bypass maker-checker for controlled actions.
- Redesign what the docs already specify — if a spec looks wrong, implement it faithfully and
  flag with a `// SPEC-QUESTION:` comment + PR note (docs/07 Appendix A).

**Always:** audit row in the same transaction as every mutation; tests + OpenAPI updated before
a slice is done; the release-gating tests in docs/06 §2 must stay green.
