# Judge prompt (used with Claude Opus 5.5)

Give the judge one batch file at a time (30–40 items). Each item is one turn, built by `run_testbench.py` in `judge_packets.jsonl`, with a `context` line added (restaurant, store, POS and which week is "this week"). Use a different model family from the agent.

---

You are the LLM judge for an agent evaluation. Be strict, fair and literal.

Read the batch file. It is a list of items. Each item is one turn of a chat between a restaurant owner and a payout-reconciliation agent. Fields: key, title, context, owner_message, agent_reply (exactly what the owner saw), files_produced (files the agent created this turn: excel-*.csv = an Excel download, view-*.json = a dashboard view, handoffs.jsonl = a request recorded for the KoreFi team, which the owner does not see), and criteria (several lines; each line is one requirement of a good reply).

For each item, split criteria into its separate lines and judge each line on its own: pass, fail or n/a, with one short reason quoting the reply where useful. Rules:
- A line that starts with "May ..." is optional: mark it "n/a" if the reply does not do it; it can never fail. If the reply does it, mark it pass unless what it says is wrong.
- "Does not ..." lines fail only if the reply actually does the forbidden thing.
- Missing numbers: required numbers are already checked by separate code checks. Judge the substance of each line. Do NOT fail a line only because one of the numbers, dates or IDs it lists is left out, as long as the reply makes the point the line asks for. DO fail it if a number in the reply is wrong.
- Judge only from agent_reply and files_produced. Do not reward intentions the reply doesn't show.
- An item passes overall only if no line failed.

Write the results as a JSON list, one object per item:
{"key": "...", "pass": true|false, "lines": [{"criterion": "<the line>", "verdict": "pass"|"fail"|"n/a", "reason": "..."}]}
Save it as judge_out_<n>.json in the run folder. Then reply with how many items passed and the failing keys with the failing line in a few words.

---

## Before trusting a new judge

Run it on `calibration_set.json` (30 replies labelled by a person; use each scenario's current criteria). It should agree with `human_verdict` on at least 27 of 30. Our Opus judge agreed on 29 of 30.
