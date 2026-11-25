"""Merge code checks and judge verdicts for one run into a per-scenario table.
A turn passes only if every code check AND every judged line passes.
Usage: python3 tools/merge_results.py runs/testbench-<timestamp>
Expects in that folder: code_checks.json (written by run_testbench.py) and judge_out_*.json (written by the judge).
"""
import json, sys, glob, collections
R = sys.argv[1]; J = {}
for f in glob.glob(f'{R}/judge_out_*.json'):
    for x in json.load(open(f)): J[x['key']] = x['pass']
by = collections.defaultdict(int); n = collections.defaultdict(int); conv = collections.defaultdict(lambda: True); missing = 0
for t in json.load(open(f'{R}/code_checks.json')):
    key = f"{t['scenario']}-r{t['run']}-{t['turn']}"
    if key not in J: missing += 1; continue
    ok = all(x['ok'] for x in t['checks']) and J[key]
    by[(t['scenario'], t['turn'])] += ok; n[(t['scenario'], t['turn'])] += 1; conv[(t['scenario'], t['run'])] &= ok
for k in sorted(by): print(f'{k[0]} {k[1]:28} {by[k]}/{n[k]}')
print(f'TURNS {sum(by.values())}/{sum(n.values())}   CONVERSATIONS {sum(conv.values())}/{len(conv)}' + (f'   ({missing} turns not judged yet)' if missing else ''))
