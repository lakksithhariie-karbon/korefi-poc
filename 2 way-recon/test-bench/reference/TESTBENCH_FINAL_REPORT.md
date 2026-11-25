# 2-way recon test bench: where we landed

**Date:** 25 Nov 2026. **Agent:** pi coding agent, `openai/gpt-6-luna`, thinking medium. **Judge:** Claude Opus 5.5 (agrees with human labels on 29 of 30). **Test bench v6:** 16 scenarios, 5 runs each, **real issues only** (the synthetic issue is retired).

## Result (run 8, one clean run on the final rules)

**96 of 110 turns pass, and 68 of 80 conversations.** v6 is harder than v5: it adds three real issues from customer data (a ghost order, an order DoorDash cancelled unpaid but the POS kept, and a promotion the POS recorded differently) and two by-design cases (catering, Tru Nature's unlinked POS).

| Scenario | Run 8 |
|---|---|
| 01 Clean week | 5/5 |
| 02 Toast $12 lower / owner disputes / week before | 4/5, 5/5, 5/5 |
| 03 Why a cancelled Uber order isn't flagged | **2/5** |
| 04 Grubhub Excel, nothing in it | 5/5 |
| 05 Change an order in Toast / profit | 5/5, 5/5 |
| 06 Uber Eats only, emailed every Monday | 5/5 |
| 07 DoorDash Excel, four weeks (DE02E3DC) | 5/5 |
| 08 Pie chart | 5/5 |
| 09–11 Fees, missing report, payout breakdown | 29/30 |
| 13 POS doesn't record delivery orders | 5/5 |
| **14 Ghost order (real)** | **3/5** |
| **15 Cancelled unpaid, Square kept it (real) / why** | **1/5, 2/5** |
| 16 Catering week | 5/5 |
| 17 Promotion recorded differently (real) | 5/5 |

## What still fails, and what to do about it

| Gap | Runs | Recommendation |
|---|---|---|
| Tells the owner "the KoreFi team will look into it" but **doesn't record the request** | 5 of 10 in 14–15 | **Move it to code.** When the matcher finds a ghost order or an order the app cancelled unpaid, code should log the KoreFi follow-up. The agent only tells the owner. A step that must always happen shouldn't depend on the model remembering it |
| Gives the reason for DE02E3DC but not the fix (match DoorDash's hours, or pause before closing) | 3 of 5 | Keep as a skill rule; recheck on the production model |
| Doesn't say why Uber still paid for D9ECF | 3 of 5 | Same |
| One payout breakdown that doesn't add up (scenario 11) | 1 of 5 | Watch in the 30-run test |

The remaining failures are now about following detailed instructions, not about getting facts wrong. Further prompt tuning on gpt-6-luna has diminishing returns, and it risks fitting the test. The next real signal comes from the production model.

## What changed to get here (v5 → v6)

- **New real data:** OOOT July (Toast) with DoorDash's cancelled-orders report, for ghost order CC78C7BF. HolyShred Geary (Square), with DE02E3DC, 12 catering orders, and buy-1-get-1 order 1D117DE3.
- **Skill rules:**
  - An order the app cancelled unpaid but the POS kept is an issue. The payout is right, the POS's sales are too high, and the KoreFi team follows up.
  - Catering and promotions recorded differently aren't issues.
  - "Mx Did Not Confirm" is explained.
  - Notes in the data count as data, not guesses: this fixed a rule conflict that made the agent withhold the store-hours reason.
  - Exact plain wording for impact and for cancelled-but-paid orders.
  - Replies when handing over a file stay short.
- **Synthetic issue retired:** scenario 12 is archived and Eggholic is genuinely clean. 05 now asks to mark an order completed in Toast; 07 moved to the real issue DE02E3DC.
- **Test fixes:**
  - The agent is now told today's date and the latest week. Without it, "this week" was ambiguous in user-first scenarios, which caused the wrong-order answers in 02 and the wrong week in 06.
  - Either label is accepted for a "recurring email" or "send to someone" request.
  - Scenario 17's data mixed before- and after-discount totals.
  - Two patterns that would have failed correct answers were removed before running.
- **Data finding:** DoorDash **did** pay "Long Fulfillment Time" cancellations in the real data (Paid = true on 4 orders), even though its help page says it doesn't.

---

# Earlier versions (v1–v5)


**92 of 95 turns pass, and 63 of 65 conversations.** This is on test bench v5, which corrects a wrong answer in the earlier versions (below).

The 3 misses are all in scenario 02. In two runs, the agent explained the $12 Toast gap without naming the order. In one run, it named the wrong order: it took the week-before order (8178D310, paid $8.28) for this week's (32A03F68, paid $11.28). That last one is the most serious kind of error, two similar orders mixed up, so it's worth watching in the 30-run test.

## Why v5 changed the answer key

The Ops P&L work checked DoorDash's portal. It showed that the two orders the test bench treated as real issues, **32A03F68 and 8178D310, are "Cancelled – Paid"**: the customer cancelled a pickup order after the store made it, and DoorDash paid. Voiding them in Toast was correct. DoorDash's own report wrongly says "Picked Up" for these. Across about 5,300 orders at two customers, no difference was left unexplained once the matching rules were in place.

So the earlier runs scored the agent against a wrong answer: it was flagging a non-issue because our rule told it to. v5 fixes the rule and the data:

- **Rule:** an order cancelled after the store made it, which the app still paid, counts as matched. At most a quiet line, never a flag. Wording depends on the POS: Toast voids it to $0 and leaves it out of its sales; Square keeps the payment.
- **Rule:** a difference the code can't explain stays flagged; the agent never explains it away. A clean week gets one or two lines.
- **Rule:** when the POS never sees delivery orders, say the check isn't possible and why; never call the app orders missing.
- **Data:** this week (5–11 Oct) is clean, 167 of 167. The week before has **one synthetic issue, marked as such** (DoorDash 7E48C896, $21.59, removed from Toast; see `test-bench/synthetic.json`), so the test bench still tests a real problem.
- **Scenarios rewritten:**
  - 01 clean week.
  - 02 "why does Toast show $12 less than DoorDash", then the owner pushes back, then the week before.
  - 05 "add the missing order to Toast" (the agent can't).
  - 07 Excel with the one real issue.
- **New:**
  - 12: after a clean summary, "and the week before?" finds the synthetic issue.
  - 13: Tru Nature on Clover, where the POS never sees delivery orders.
- **Left out on purpose:** Square naming variants and Uber reusing order codes. These test the matching code, not the agent, so they're written up as code test cases instead.

| Scenario | v5 |
|---|---|
| 01 Clean week summary | 5/5 |
| 02 Toast lower than DoorDash / owner disputes / week before | 3/5, 4/5, 5/5 |
| 03 Why a cancelled Uber order isn't flagged | 5/5 |
| 04 Grubhub Excel with nothing in it | 5/5 |
| 05 Add an order to Toast / profit | 5/5, 5/5 |
| 06 Uber Eats only, emailed every Monday | 5/5 |
| 07 DoorDash Excel, two weeks | 5/5 |
| 08 Pie chart | 5/5 |
| 09–11 Fees, missing report, payout breakdown | 25/25 |
| 12 Clean week, then "the week before?" (synthetic issue) | 5/5, 5/5 |
| 13 POS doesn't record delivery orders | 5/5 |

v5 numbers combine run 5 with targeted reruns of 02, 04 and 12, after three wording rules: say plainly that a cancelled-but-paid order isn't a problem; say a missing order isn't lost money because the app paid it; never mention a download when there's nothing to download. Scenario 12 also became a follow-up to the summary, because asked cold, "the week before" was ambiguous.

---

# Earlier runs (v1–v4)

## Result (v1–v4)

**The agent now passes 72 of 75 turns and 52 of 55 conversations (run 4).** The three misses had one cause, fixed and confirmed in a targeted rerun.

**The judge agrees with the human labels on 29 of 30 replies**, above the 27 target, so its scores can be trusted at this scale.

| | Turns passing | Conversations passing | Scored against |
|---|---|---|---|
| Run 1 | 38 / 75 | 21 / 55 | First criteria (mine) |
| Run 2 | 63 / 75 | 44 / 55 | First criteria, judge rule for missing numbers |
| Run 3 | 58 / 75 | 38 / 55 | **Final criteria** (calibrated with your labels) |
| **Run 4** | **72 / 75** | **52 / 55** | **Final criteria** |

Runs 1–2 and runs 3–4 were scored against different criteria, so only 3 → 4 is a direct comparison. The final criteria are stricter in some places (likely reasons, no mention of Excel) and looser in others.

**Targeted rerun after the last fix** (scenarios 03 and 10, 5 runs each):
- **Scenario 10 summary:** 5/5, up from 2/5.
- **Scenario 03:** 3/5. One reply left out the order ID. One gave Uber's payment rule without the "not the restaurant's fault" condition.

At 5 runs, a 2-run swing is within normal variation. The 30-run test will settle it.

## How we got here

| Step | What changed | Effect |
|---|---|---|
| Run 1 | Baseline | Correct numbers and no overreach, but explained too little, declined without alternatives, wrong week in views |
| Five skill rules (your call) | Explain why it matters; offer alternatives; POS edits go back to the owner; this week by default; Excel holds issues only | Run 2: 63/75 |
| Your 30 labels | The judge was stricter than you on 7 replies, all because of criteria I wrote | Criteria rewritten to your standard; judge agreement 18 → 29 of 30 |
| Your rules | KoreFi team only acts on recurring or sending requests and POS-orders-missing-from-app; basic asks logged quietly; no promised dates; say when missing reports arrive; payout figures from the report only; no Excel mention when nothing to look at | Built into criteria and skill |
| Help-page research | 79 sourced reasons for mismatches; directly read ones added as "likely reasons" | The agent explains cancelled-but-paid orders |
| Four wording rules | Give the likely reason unasked; never mention an empty Excel; call it an Excel file; repeat amounts in follow-ups | Run 4: 72/75 |
| Scope fix | Likely reasons only when the owner asks about that order, never in the weekly summary | Scenario 10 back to 5/5 |

## What the agent does reliably now

- **Facts:** every number comes from the data. It never claims an overcharge, never says money was lost, never says something was sent or scheduled, never changes data.
- **Weekly summary:** leads with the result and names each issue. An Excel holds only the orders to look at. It says honestly when an app's report hasn't arrived and when to come back.
- **Follow-ups:** explains why an issue matters and gives sourced likely reasons as "likely". It repeats amounts and keeps the thread across turns.
- **Requests:** this week's view by default. Recurring or sending requests are handed to the KoreFi team with no date promised. Pie-chart-type asks are logged quietly. POS changes go back to the owner.

## Problems found and fixed in the test itself

- **Two wrong code checks,** and criteria stricter than your standard. Both fixed.
- **Judges disagreed on missing numbers.** The rule now is that code checks the numbers and the judge rates the substance.
- **Runs hanging:** pi sometimes waited for keyboard input that never came, so whole runs timed out. The runner now closes pi's input, retries a timed-out turn once, and stops early. The voided runs are kept as `runs/VOID-timeout-*`.

## Still open

1. **Production model:** Apurv to confirm which model the production agent will use. Rerun on it.
2. **30 runs per scenario** on that model, to measure consistency (the scenario files' setting).
3. **DoorDash quotes:** the likely-reason quotes from DoorDash came from search copies, because DoorDash blocked automated reading. Check them in a normal browser before customers see them.
4. **Real tools:** Excel files, views and KoreFi-team requests were files the agent wrote. Rerun once Apurv's tools exist.
5. **Grow the test bench:** add scenarios for the new rules, such as an order in the POS but missing from an app's report (which the KoreFi team follows up), and a late report arriving mid-week.

## Files

| What | Where |
|---|---|
| Scenarios, skill file, data | `test-bench/` (pre-calibration copy in `archive/test-bench-v3-before-calibration`) |
| Runner | `tools/run_testbench.py` |
| Runs 1–4 and the targeted rerun | `runs/testbench-20261124-104353`, `-110519`, `-145537`, `-164343`, `-164906` |
| Your labels | `runs/testbench-20261124-104353/human_labels_final.json` |
| Mismatch research | `research/mismatch-reasons.md` |
