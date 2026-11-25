# How to run the payout recon eval

Everything another person or model needs to rerun this test bench and get comparable numbers.

## 1. What a run does

For each scenario, `tools/run_testbench.py` gives the agent the skill file and the scenario's two data files, then plays the conversation turn by turn (a scheduled trigger or the owner's messages). It never shows the agent the scenario YAML. It saves every reply and every file the agent made, applies the **code checks**, and writes **judge packets** for the LLM judge. A turn passes only if every code check and every judged line passes.

## 2. Setup

- Python 3 with `pyyaml`.
- An agent the runner can call from the command line. The eval used the **pi coding agent** (`npm i -g @earendil-works/pi-coding-agent@1.5.2`) on OpenRouter. To use another agent, change the `cmd` list in `run_one()`. It must accept a system prompt file, a message, and a way to continue the same conversation.
- Set `OPENROUTER_API_KEY`, `PI_MODEL=openai/gpt-6-luna` and `PI_THINKING=medium` in your shell or in `test-bench/.env`. Change `PI_MODEL` to test another model.

## 3. Run

Run these commands from `test-bench/`.

```
python3 tools/run_testbench.py --runs 5 --jobs 4 --timeout 180      # all scenarios, 5 runs each
python3 tools/run_testbench.py --runs 5 --only 14 15                 # some scenarios
```

Results go to `runs/testbench-<timestamp>/`: one JSON per conversation, `code_checks.json` and `judge_packets.jsonl`. The scenario files say `runs: 30`. Use 5 to find gaps, and 30 for a final consistency measure.

## 4. Judge

1. Split `judge_packets.jsonl` into batches of 30–40. To each item, add a `context` line: restaurant, store, POS, and which dates are "this week" (from the scenario's `period`).
2. Give each batch to the judge with `judge/judge_prompt.md`, and save its output as `judge_out_<n>.json` in the run folder. Use a different model family from the agent; we used Claude Opus 5.5.
3. Score: `python3 tools/merge_results.py runs/testbench-<timestamp>`.

**Before trusting a new judge,** run it on `judge/calibration_set.json` and check it agrees with the human verdict on at least 27 of 30.

## 5. The tools are stand-ins

The production tools don't exist yet, so the agent "acts" by writing files in `./out`. The format is given in its prompt (`GLOBAL` in the runner):
- **Excel:** `out/excel-<name>.csv` (columns: app, order_date, order_id, app_amount, issue).
- **View:** `out/view-<name>.json` (`filters`, `orders`, `matched`, `app_sales`).
- **KoreFi request:** a line in `out/handoffs.jsonl` (`to`, `request`, `details`, `alert`).

When the real tools exist, change the prompt and the checks in `check_turn()` to match.

## 6. Code checks (in each scenario's `expect`)

| Check | Meaning |
|---|---|
| `facts` | Each value appears in the reply (numbers compared ignoring $ and commas) |
| `must_mention` / `must_not_mention` | Words that must or must not appear |
| `must_not_mention_pattern` | A regex that must not match |
| `max_words` | Length limit |
| `artifact` | `none`, or an Excel (rows, order IDs, total, apps) or a view (apps, orders, matched, sales) |
| `actions_taken: []` | The data folder was not changed |
| `handoff` | A KoreFi-team request was recorded (type, alert, details), or `none` |

## 7. Lessons that save time

- **Close the agent's input.** pi waits for keyboard input if started without it, and whole runs then time out. The runner passes `stdin=DEVNULL`, retries a timed-out turn once, and stops after 6 timeouts in a row. Treat any run with empty replies as void.
- **Tell the agent today's date and the latest week.** Without it, "this week" is ambiguous when the data has two weeks, and the agent picks the wrong one. The runner adds this.
- **Write patterns that catch a claim, not its denial.** "needs a look" also matches "nothing needs a look"; "you were overcharged" also matches "I can't tell whether you were overcharged". Test every pattern against a correct reply before running.
- **Calibrate the criteria, not only the judge.** Our first criteria were stricter than the product owner's own standard. 30 human labels showed which lines to make optional ("May …").
- **Check the expected answers against the source.** Two "issues" in an early version were customer cancellations that DoorDash had paid. The portal showed it; DoorDash's report said "Picked Up". Every answer key needs the same scrutiny as the agent's replies.
- **Avoid rule conflicts.** "Only give reasons from the list" stopped the agent passing on a reason written in the data. The skill file now says notes in the data are data.

## 8. Rebuilding the data

The eval runs on the prepared datasets in `data/`. The raw exports and dataset builders live outside this repository.

## 9. Background reading

- `reference/LEARNINGS_FROM_OPS_PNL.md`: how app and POS data behave, and why orders mismatch.
- `reference/CODE_TEST_CASES_MATCHING.md`: test cases for the matching code.
- `reference/mismatch-reasons.md`: likely reasons for mismatches, each with a source link.
- `reference/2026-11-25-eval-report.pdf`: the latest rerun and the per-scenario results.
- `reference/TESTBENCH_FINAL_REPORT.md`: Run 8 and the history leading up to it.
