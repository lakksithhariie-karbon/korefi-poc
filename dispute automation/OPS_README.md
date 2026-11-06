# KoreFi Dispute Assistant, Ops pilot

## New capabilities

The existing DoorDash capture, screenshot redaction, AI assessment and chat are preserved. An **Ops Queue** tab adds deadline-first triage, duplicate capture normalization, a per-case evidence checklist, a manual filing reference, owner/notes, won/lost outcomes, actual credit received and CSV export. Each saved action logs operator and timestamp in the case's local audit.

**Scope:** One Chrome profile. There is no shared backend, multi-operator synchronization, DoorDash submission, or automated financial reconciliation. Evidence checkboxes are human attestations, **not uploads**. The 14-day deadline is a configurable POC assumption that must be validated against the merchant's current contract/portal.

## Install

Chrome > chrome://extensions > Developer mode > Load unpacked > choose `dist/`. Open the DoorDash merchant portal, click the KoreFi extension icon, enable Capture, add an OpenAI key to Settings to use AI recommendations. Open an order, then use the Ops Queue tab to review evidence and record outcomes. Without a key, deterministic triage and ops tracking still work.

## Recommended pilot procedure

1. Capture an order and confirm charge amount and eligibility in DoorDash.
2. Review AI recommendation and evidence list. Never interpret a suggested dispute as verified proof.
3. Mark each externally-held evidence item as verified only after personally checking it.
4. Submit a dispute manually in DoorDash and paste the returned reference. Use **Confirm filed in DoorDash**.
5. After a decision, mark won or lost; record the actual credit separately from the win outcome.
6. Export the CSV for internal reconciliation. Store the CSV securely.

## Important limitations

- API key is stored in Chrome local storage and the AI SDK operates in-browser. Use with a controlled pilot account only; move model calls behind an authenticated server before broad rollout.
- Original scraper was trained on one DoorDash page sample. The 14-day eligibility rule is not guaranteed across agreements; independently verify.
- Data is local to the browser profile. Local storage may be lost when the profile or extension is removed. Export regularly.
- Do not assume `won` means the credit was paid. Use the distinct `creditReceived` and `recoveredAmount` fields.
- Automatic deduplication matches on order ID and placement timestamp. Do not treat this as a cross-outlet primary key for a shared database.
