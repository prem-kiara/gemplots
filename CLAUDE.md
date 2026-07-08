# Gem Plots Platform (Gem Housing)

You are implementing a specified architecture, not designing one.

**Start here every session:**
1. Read [HANDOVER.md](HANDOVER.md) — especially the Invariants (hard constraints; they override
   test expectations and your own judgment).
2. Read [docs/09-build-instructions-v2.md](docs/09-build-instructions-v2.md) plus the session
   protocol in [docs/07-build-instructions.md](docs/07-build-instructions.md) §0. Work exactly
   one slice per session, in order (P0 → P8).
3. Spec precedence: [docs/08-gemhousing-pivot.md](docs/08-gemhousing-pivot.md) **wins over
   docs 01–07** wherever they conflict; otherwise DM(02) > CF(04) > API(03).

**Never:**
- Violate a HANDOVER invariant. In particular: nothing customer-facing may set a booking to
  RESERVED — only an admin approval with `decided_by <> requested_by` (Invariant 7′).
- Use floats for money (integer paise) or naive timestamps (timestamptz UTC).
- Import a vendor SDK outside a driver interface (email/storage/payments — Invariant 11).
- Send an email that bypasses the `emails_outbox` write.
- Edit an applied migration (the one-time P0 rebrand rewrite is already spent), enable ORM
  schema-sync, or bypass maker-checker for controlled actions.
- Sniff user-agents for the mobile view — responsive CSS only.
- Redesign what the docs specify — implement faithfully, flag with `// SPEC-QUESTION:` + PR note.

**Always:** audit row in the same transaction as every mutation; portal-notification events on
reserve-flow transitions; tests + OpenAPI updated before a slice is done; TP-P release gates
(docs/08 §13) stay green.
