# Task Timeout Implementation Plan

**Goal:** Support a Web task timeout of 1–1440 minutes, default 10, persisted as codexTimeoutMs.
**Architecture:** Validate configuration at file/API boundaries, pass it to the shared runner, convert minutes in the existing settings form. Keep isolated topic detection at 45 seconds and preserve auto fallback's separate timer.
**Tech Stack:** TypeScript, Zod, existing HTML/JavaScript settings.
**Spec:** User-approved design in conversation, 2026-11-17.

- [x] Add failing configuration and API tests: legacy defaults, persistence, invalid values, omitted API field preservation.
- [x] Add codexTimeoutMs to config parsing, API schema, account runner creation; retain isolated timeout.
- [x] Add settings input and minutes conversion; document range, backend timers and save behavior in both READMEs.
- [x] Run focused tests, full suite, typecheck and build; inspect final diff.

Review focus: missing old configuration, invalid file/API values, maximum timer range, omitted API field, independent isolated calls. Existing settings saves rebuild runners and can interrupt active tasks; document this behavior.

Verification: focused tests 24/24 passed; full suite 216 passed, 1 skipped, 0 failed. Typecheck, build, JavaScript syntax and diff whitespace checks passed. Changes remain local; service was not restarted.
