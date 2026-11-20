# 2-way reconciliation agent: test bench

Scenarios for testing the payout reconciliation agent, written as YAML so a runner can execute them. This is the first set of 8. It grows as real customer questions come in.

## What the agent does, and what it doesn't

| Step | Who does it | In this test bench? |
|---|---|---|
| Pull the week's reports from the delivery apps and the POS | Code | No |
| Match orders, find missing orders, wrong amounts and unusual fees, set aside known reasons | Code | No |
| Fill the standard dashboard | Code | No |
| Write the Thursday summary for the owner | **Agent** | Yes: scenario 1 |
| Produce the Excel of all the week's issues, for the owner to share | Code | Checked in scenario 1 |
| Answer follow-up questions in chat | **Agent** | Yes: scenarios 2, 3, 5 |
| Build a filtered view the owner asks for | **Agent** picks the filter, code renders it | Yes: scenarios 4, 6, 7, 8 |
| Schedule a report or send it to someone | **KoreFi team**, by hand, after approval. The agent records the request | Yes: scenario 6 |

**Why matching is code:** across 8 real weeks, all 3,715 matched orders agreed to the cent, and every known reason for a difference is arithmetic. The agent is given the finished result and tools to look orders up.

## Folder layout

| Path | What it holds |
|---|---|
| `scenarios/` | One YAML file per scenario |
| `data/week-2026-10-19/reconciliation_result.json` | The finished result for the week: totals by app and by store, the 8 flagged orders, what was explained |
| `data/week-2026-10-19/orders.csv` | All 478 delivery orders for the week, one row each, with the app amount, POS amount and result |
| `skills/payout-reconciliation.md` | Product's draft of the business rules the agent follows |

**About the data:** it is one real week from a 4-store restaurant on Square. The restaurant and store names are replaced ("Harbor Tea"; Downtown, Northside, Westside, Beachside). Amounts, dates, times and order IDs are real. In production this data sits in the database and the agent reads it through tools; the files stand in for that here.

## The week in the data

| | Orders | Match Square | Not recorded in Square |
|---|---|---|---|
| DoorDash | 269 | 262 | 7 · $126.65 |
| Uber Eats | 197 | 196 | 1 · $18.43 |
| Grubhub | 11 | 11 | 0 |
| **All apps** | **477** | **469** | **8 · $145.08** |

- **By store:** Downtown has 6 of the 8 ($110.17). Northside and Westside have 1 each. Beachside has none.
- **Not flagged on purpose:** 1 Uber Eats order (65C9B) marked unfulfilled but still paid $31.91 and present in Square; 3 DoorDash error charges, which belong to the chargeback agent.
- **No wrong amounts and no unusual fees** this week.

## The 8 scenarios

| # | File | What the user does | What it tests |
|---|---|---|---|
| 1 | `01-weekly-summary.yaml` | Nothing: the scheduled Thursday run | Right numbers, the worst store named, plain words, nothing explained raised as an issue, and the Excel of all 8 orders |
| 2 | `02-why-and-which-store.yaml` | "Why are 8 orders off?" then "Which store is worst?" | Answers from the data, and keeps the context across two turns |
| 3 | `03-why-not-flagged.yaml` | "Uber order 65C9B was never picked up. Why isn't it on your list?" | Looks up one order and explains a known reason correctly |
| 4 | `04-excel-for-one-store.yaml` | "Give me the Excel for just the Downtown store" | An allowed filter: exactly the right 6 rows |
| 5 | `05-out-of-scope.yaml` | "Add these 8 orders to Square for me" then "Am I making a profit?" | Stays read-only, and says what it can't tell instead of guessing |
| 6 | `06-filter-plus-schedule-and-email.yaml` | "Filter this to DoorDash only, and every Monday share it with my account manager at this email" | Does the allowed part, says it can't schedule or send, and passes the rest to the KoreFi team |
| 7 | `07-two-filters-combined.yaml` | "Give me the Excel with just the DoorDash orders at Downtown" | Two filters at once: exactly the right 5 rows |
| 8 | `08-customisation-not-allowed.yaml` | "Turn this into a pie chart of sales by hour for each store" | Declines a change that isn't offered, and says what it can do |

## How a scenario file is laid out

| Field | Meaning |
|---|---|
| `id`, `title`, `use_case` | Names the scenario |
| `classification` | `trigger` (scheduled or user), `goals` and `patterns`, for grouping results later |
| `restaurant`, `pos`, `period` | Which customer and week |
| `skill` | The rules file the agent loads |
| `data` | The data files the agent can reach through its tools |
| `runs` | How many times to run it (30), since answers vary |
| `conversation` | The turns, in order. Each has `user` (the message) or `trigger: scheduled`, and `expect` |

**Inside `expect`:**

| Check | Type | Meaning |
|---|---|---|
| `facts` | Code | Each value must appear in the reply |
| `must_not_mention`, `must_not_mention_pattern` | Code | Text that must not appear |
| `max_words` | Code | Length limit |
| `artifact` | Code | For a generated Excel file or view: row count, order IDs, total, and which stores and apps may appear |
| `actions_taken` | Code | Tools the agent may call that change anything. An empty list means none |
| `handoff` | Code | A request the agent must record for the KoreFi team, with its details |
| `response.criteria` | AI judge | Plain-language description of a good reply, including what it must not do |

Code checks cover everything with one right answer. The judge covers wording and judgement.

## What the owner can change in the first version

| Request | What happens |
|---|---|
| Download all the week's issues as one Excel file | Comes with every run |
| Filter by store, by app, by issue type or by week, alone or combined | The agent does it, and the filtered list downloads as Excel |
| A recurring report, or sending it to another person | The agent does not. It records the request, and the KoreFi team approves it and sends the email by hand |
| Any other change, such as a new chart or layout | Not available yet. The agent says so and notes the request |

Scheduling and sending move into the product once enough owners ask for them.

**The agent does not say who a finding should go to.** It reports the issues and provides the Excel; the owner chooses who to share it with.

## Out of scope for now

- **Insights on the Home page, and ranking insights across agents.** These wait until 2 or 3 agents are live. Until then each agent's insights live in its own run result, which scenario 1 tests.
- **Adding the owner's own files** in chat.
- **Bank deposits** (3-way reconciliation) and Grubhub fees.

## Open points for review

- **Field names are a proposal.** They follow the Neo reference, adapted to our case. Rename anything to fit the runner.
- **Recording a request for the KoreFi team needs a small tool** (the `handoff` check). Where the request lands, such as a table or a channel, is not decided.
- **Tool names are not specified.** The scenarios say which data the agent can reach, not how. That is engineering's call.
- **The skill file is a draft** of the business rules, not final prompt wording.
- **One week only.** Questions such as "and the week before?" need a second week of data.
- **Ops has not yet confirmed** in Square that the 8 flagged orders are truly absent.

## Next scenarios to add

- A clean week: the summary is one line.
- A week with a wrong amount and an unusual fee, to test ranking by money.
- More than 5% of a store's orders missing: reported once, not order by order.
- A question that needs a second week ("Is this getting worse?").
