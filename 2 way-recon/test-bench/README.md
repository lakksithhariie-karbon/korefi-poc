# 2-way reconciliation agent: test bench (v6)

The test bench evaluates how KoreFi's payout reconciliation agent summarizes last week's delivery-app orders (DoorDash, Uber Eats, Grubhub) against the restaurant's POS (Toast, Square, Clover) and answers follow-up questions. See [how to run the eval](HOW_TO_RUN.md).

## What is tested, and what isn't

| Step | Who does it | In this test bench? |
|---|---|---|
| Pull reports from the apps and the POS | Code | No |
| Match orders; classify each difference | Code | No (see `reference/CODE_TEST_CASES_MATCHING.md` for matching tests) |
| Write the Thursday summary | **Agent** | Yes |
| Answer follow-up questions | **Agent** | Yes |
| Change the view, make an Excel | **Agent** picks the filter, code renders it | Yes |
| Schedule or send anything | **KoreFi team**, by hand; the agent records the request | Yes |

The agent gets the finished matching result. It never matches orders itself.

## Folders

| Path | What it holds |
|---|---|
| `scenarios/` | One YAML file per scenario: turns, code checks, judge criteria |
| `skills/payout-reconciliation.md` | The business rules the agent follows (product's draft) |
| `data/` | Five real datasets, names replaced; amounts, dates, times and app order IDs are real; no customer names |
| `tools/run_testbench.py` | Runs every scenario with the agent and applies the code checks |
| `tools/merge_results.py` | Combines code checks and judge verdicts into a score |
| `judge/judge_prompt.md` | The LLM judge's instructions |
| `judge/calibration_set.json` | 30 replies labelled by a person, to check a judge before trusting it |

## Datasets

| Folder | Restaurant (renamed) | POS | What's in it |
|---|---|---|---|
| `weeks-2026-09-28_2026-10-11` | Mango Street Kitchen, Oakridge | Toast | Two clean weeks: every order matches. 2 DoorDash orders cancelled by the customer after the store made them, which DoorDash still paid (Toast voids these to $0) |
| `weeks-2026-11-02_2026-11-15-uber-only` | Pepper Lane Cantina, Maplewood | Toast | Only the Uber Eats report arrived; includes Uber's payout breakdown |
| `week-2026-11-09-pos-not-linked` | Green Leaf Juice Co, Harbor | Clover | Delivery orders never reach this POS, so order-by-order checking is impossible |
| `week-2026-07-13-ghost-order` | Juniper Tea Co, 4 stores | Toast | **Real issue:** ghost order CC78C7BF. DoorDash cancelled it within seconds and paid nothing; Toast kept it as a sale and the kitchen made it. Includes DoorDash's cancelled-orders report |
| `weeks-2026-10-05_2026-11-01-geary` | Bright Bowl, Mission | Square | **Real issue:** DE02E3DC, cancelled by DoorDash as "Store closed", unpaid, but completed in Square. Also 12 catering orders (never sent to Square, by design) and a buy-1-get-1 order Square recorded with one free item |

## Scenarios (16)

| # | Scenario | Turns |
|---|---|---|
| 01 | Thursday summary for a clean week | 1 |
| 02 | Why Toast shows $12 less DoorDash; owner pushes back; the week before | 3 |
| 03 | Why a cancelled-but-paid Uber order isn't flagged | 1 |
| 04 | Excel of Grubhub issues when there are none | 1 |
| 05 | Asked to change an order in the POS; then "am I profitable?" | 2 |
| 06 | Uber Eats-only view, emailed to the accountant every Monday | 1 |
| 07 | Excel of DoorDash issues over four weeks (one real issue) | 1 |
| 08 | A chart the product doesn't offer | 1 |
| 09 | "Did DoorDash overcharge me?" | 1 |
| 10 | Only one app's report arrived; "is DoorDash fine too?" | 2 |
| 11 | Why Uber paid far less than the sales; "is 24% right?" | 2 |
| 13 | POS doesn't record delivery orders | 1 |
| 14 | Weekly summary with a ghost order (real) | 1 |
| 15 | Weekly summary with an order the app cancelled unpaid (real); why | 2 |
| 16 | Week with catering orders | 1 |
| 17 | Why Square is $5.69 higher on one order (promotion recorded differently, real) | 1 |

Scenario 12 was retired when real order issues replaced the synthetic example.

## Latest result

The 25 November 2026 rerun passed **101 of 110 turns and 75 of 80 conversations** with GPT-6 Luna as the agent and Claude Opus 5.5 as the judge. Scenario 15 accounted for eight of the nine failed turns. The agent omitted required KoreFi follow-up records or advice on adjusting DoorDash hours.

See the [latest PDF report](reference/2026-11-25-eval-report.pdf) for the full scenario breakdown and the [previous v6 report](reference/TESTBENCH_FINAL_REPORT.md) for Run 8 and earlier results.
