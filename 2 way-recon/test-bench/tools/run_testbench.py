"""Run the 2-way recon test bench (test-bench/scenarios/*.yaml) with the pi agent, then apply the code checks.
The LLM-judge criteria are written out for a separate judge (judge_packets.jsonl); this script never judges.

Usage:
  python3 tools/run_testbench.py --runs 5 --jobs 6            # all scenarios
  python3 tools/run_testbench.py --runs 1 --only 01 06       # some scenarios

Agent sees ONLY: the global prompt below + the scenario's skill file + the scenario's data files. Never the YAML.
Production tools don't exist yet, so they are simulated with files the agent writes in ./out:
  Excel download  -> out/excel-<name>.csv   (columns: app, order_date, order_id, app_amount, issue)
  Filtered view   -> out/view-<name>.json   ({"filters": {...}, "orders": n, "matched": n, "app_sales": x})
  KoreFi request  -> append one JSON line to out/handoffs.jsonl ({"to": "korefi_team", "request": ..., "details": "..."})
"""
import argparse, concurrent.futures as cf, csv, datetime as dt, glob, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time
import yaml

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TB = os.path.join(HERE, 'test-bench') if os.path.isdir(os.path.join(HERE, 'test-bench', 'scenarios')) else HERE   # works from Recon eval/ or from inside test-bench/

GLOBAL = """You are KoreFi's payout reconciliation agent. You talk to a restaurant owner in a chat.
The week's delivery orders have already been matched to the POS by code. The results are in ./data: reconciliation_result.json (totals, issues, explained items, payouts) and orders.csv (one row per order). Read them with your tools. ./data is read-only: never change, move or delete anything there.
Your final message in each turn is exactly what the owner sees. Write it for the owner: plain words, no file names, no mention of tools, folders or JSON.

You have three actions, done by writing files in ./out (create the folder if needed). Do nothing else outside ./out.
1. Give the owner an Excel file: write ./out/excel-<short-name>.csv with the columns app, order_date, order_id, app_amount, issue (one row per order). The owner gets it as an Excel download.
2. Show the owner a filtered view of the dashboard: write ./out/view-<short-name>.json as {"filters": {"apps": [...], "weeks": [...], "issue_types": [...]}, "orders": <app orders shown>, "matched": <matched>, "app_sales": <app sales in dollars>}.
3. Record a request for the KoreFi team: append one line to ./out/handoffs.jsonl as {"to": "korefi_team", "request": "<recurring_email | send_to_someone | pos_order_missing_from_app | feature_request | other>", "details": "<what the owner asked for, in full>", "alert": <true if the team should act on it, false if it is only logged>}.
Follow the business rules below."""

def load_env():
    env = dict(os.environ)
    for line in open(os.path.join(HERE, '.env')) if os.path.exists(os.path.join(HERE, '.env')) else []:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1); env[k.strip()] = v.strip()
    return env

def scheduled_msg(sc):
    w = sc['period']['this_week']; thu = w['to'] + dt.timedelta(days=4)
    return (f"[Scheduled run, {thu:%A %d %B %Y}] The reconciliation for the week {w['from']:%d %b} to {w['to']:%d %b %Y} is ready. "
            f"Write this week's summary message for the owner.")

def snapshot(d):
    out = {}
    for p in glob.glob(os.path.join(d, '**', '*'), recursive=True):
        if os.path.isfile(p): out[os.path.relpath(p, d)] = hashlib.md5(open(p, 'rb').read()).hexdigest()
    return out

HUNG, HUNG_LIMIT = {'n': 0}, 6   # consecutive timeouts across all jobs before giving up

def run_one(sc, n, env, model, thinking, root, timeout):
    work = tempfile.mkdtemp(prefix=f"tb-{sc['_key']}-r{n}-"); os.makedirs(os.path.join(work, 'data')); os.makedirs(os.path.join(work, 'out'))
    for f in sc['data']: shutil.copy(os.path.join(TB, f), os.path.join(work, 'data'))
    prompt = os.path.join(work, '..', f"prompt-{os.path.basename(work)}.md")
    w = sc['period']['this_week']; today = w['to'] + dt.timedelta(days=4)
    when = (f"Today is {today:%A %d %B %Y}. The latest week in the data is {w['from']:%d %b} to {w['to']:%d %b %Y}: when the owner says \"this week\" or \"last week\" without a date, they mean that week. "
            "The week before it is \"the week before\".")
    open(prompt, 'w').write(GLOBAL + '\n' + when + '\n\n' + open(os.path.join(TB, sc['skill'])).read())
    sess = os.path.join(work, '..', f"sess-{os.path.basename(work)}"); os.makedirs(sess)
    data0 = snapshot(os.path.join(work, 'data')); turns = []
    for i, t in enumerate(sc['conversation']):
        msg = scheduled_msg(sc) if t.get('trigger') == 'scheduled' else t['user']
        before = snapshot(os.path.join(work, 'out'))
        cmd = ['pi', '-p', '--session-dir', sess, '--provider', 'openrouter', '--model', model, '--thinking', thinking,
               '--append-system-prompt', prompt] + (['-c'] if i else []) + [msg]
        t0 = time.time(); reply, err = '', ''
        for attempt in (1, 2):   # the API sometimes hangs: retry a timed-out turn once
            if HUNG['n'] >= HUNG_LIMIT: err = 'SKIPPED: API not answering'; break
            try:
                r = subprocess.run(cmd, cwd=work, env=env, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL); reply, err = r.stdout.strip(), r.stderr
                HUNG['n'] = 0; break
            except subprocess.TimeoutExpired:
                HUNG['n'] += 1; err = f'TIMEOUT {timeout}s (attempt {attempt})'
        after = snapshot(os.path.join(work, 'out'))
        new = {k: open(os.path.join(work, 'out', k)).read() for k in after if before.get(k) != after[k]}
        turns.append(dict(id=t['id'], message=msg, reply=reply, stderr=err[-2000:], seconds=round(time.time() - t0, 1), new_files=new,
                          data_changed=snapshot(os.path.join(work, 'data')) != data0))
    res = dict(scenario=sc['_key'], id=sc['id'], run=n, turns=turns)
    json.dump(res, open(os.path.join(root, f"{sc['_key']}-r{n}.json"), 'w'), indent=1)
    shutil.rmtree(work, ignore_errors=True); shutil.rmtree(sess, ignore_errors=True)
    try: os.remove(prompt)
    except OSError: pass
    return res

# ---------- code checks ----------
def nums(text): return [float(x.replace(',', '')) for x in re.findall(r'\d[\d,]*\.?\d*', text)]
def has_fact(reply, v):
    if isinstance(v, (int, float)) or re.fullmatch(r'[\d,]+(\.\d+)?', str(v)):
        target = float(str(v).replace(',', '')); return any(abs(x - target) < 0.005 for x in nums(reply))
    return str(v).lower() in reply.lower()

def check_turn(exp, tr):
    out = []; reply = tr['reply']
    for k, v in (exp.get('facts') or {}).items(): out.append((f'fact {k}={v}', has_fact(reply, v)))
    for w in exp.get('must_mention') or []: out.append((f'mentions "{w}"', w.lower() in reply.lower()))
    for w in exp.get('must_not_mention') or []: out.append((f'does not mention "{w}"', w.lower() not in reply.lower()))
    if exp.get('must_not_mention_pattern'): out.append((f'no match for /{exp["must_not_mention_pattern"]}/', not re.search(exp['must_not_mention_pattern'], reply)))
    if exp.get('max_words'): wc = len(reply.split()); out.append((f'max {exp["max_words"]} words (got {wc})', wc <= exp['max_words']))
    if 'actions_taken' in exp: out.append(('nothing changed outside ./out', not tr['data_changed']))
    files = tr['new_files']; excels = {k: v for k, v in files.items() if k.startswith('excel-')}; views = {k: v for k, v in files.items() if k.startswith('view-')}
    a = exp.get('artifact')
    if a == 'none': out.append(('no file or view produced', not excels and not views))
    elif isinstance(a, dict) and a.get('type') == 'excel':
        out.append(('exactly one Excel file', len(excels) == 1))
        if excels:
            rows = list(csv.DictReader(next(iter(excels.values())).splitlines()))
            ids = {r.get('order_id', '').strip().upper() for r in rows}
            if 'rows' in a: out.append((f'Excel has {a["rows"]} rows (got {len(rows)})', len(rows) == a['rows']))
            if 'order_ids' in a: out.append((f'Excel order ids {a["order_ids"]}', ids == {x.upper() for x in a['order_ids']}))
            if 'total_amount' in a:
                tot = sum(float(re.sub(r'[^\d.\-]', '', r.get('app_amount', '') or '0') or 0) for r in rows)
                out.append((f'Excel total {a["total_amount"]} (got {tot:.2f})', abs(tot - float(a['total_amount'])) < 0.005))
            if 'apps' in a: out.append((f'Excel apps only {a["apps"]}', {r.get('app', '').strip() for r in rows} <= set(a['apps'])))
    elif isinstance(a, dict) and a.get('type') == 'view':
        out.append(('exactly one view', len(views) == 1))
        if views:
            try: v = json.loads(next(iter(views.values())))
            except Exception: v = {}
            out.append((f'view apps {a["apps"]}', [x for x in (v.get('filters') or {}).get('apps', [])] == a['apps']))
            for k in ('orders', 'matched'): out.append((f'view {k}={a[k]}', v.get(k) == a[k]))
            out.append((f'view app_sales={a["app_sales"]}', abs(float(v.get('app_sales') or 0) - float(a['app_sales'])) < 0.005))
    h = exp.get('handoff'); hl = [json.loads(l) for k, txt in files.items() if k == 'handoffs.jsonl' for l in txt.splitlines() if l.strip().startswith('{')]
    if h == 'none': out.append(('no request recorded', not hl))
    elif h:
        reqs = h['request'] if isinstance(h['request'], list) else [h['request']]
        ok = [x for x in hl if x.get('to') == h['to'] and x.get('request') in reqs and ('alert' not in h or x.get('alert') == h['alert'])]
        out.append((f'request recorded: {h["request"]}' + (f' (alert {h["alert"]})' if 'alert' in h else ''), bool(ok)))
        for d in h.get('details') or []:
            out.append((f'request details include "{d}"', any(d.lower() in json.dumps(x).lower() for x in ok)))
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--runs', type=int, default=5); ap.add_argument('--jobs', type=int, default=6)
    ap.add_argument('--only', nargs='*'); ap.add_argument('--timeout', type=int, default=600); a = ap.parse_args()
    env = load_env(); model, thinking = env.get('PI_MODEL', 'openai/gpt-6-luna'), env.get('PI_THINKING', 'medium')
    scs = []
    for f in sorted(glob.glob(os.path.join(TB, 'scenarios', '*.yaml'))):
        sc = yaml.safe_load(open(f)); sc['_key'] = os.path.basename(f).split('-')[0]
        if not a.only or sc['_key'] in a.only: scs.append(sc)
    root = os.path.join(HERE, 'runs', 'testbench-' + dt.datetime.now().strftime('%Y%m%d-%H%M%S')); os.makedirs(root)
    json.dump(dict(model=model, thinking=thinking, runs=a.runs, global_prompt=GLOBAL), open(os.path.join(root, 'config.json'), 'w'), indent=1)
    jobs = [(sc, n) for n in range(1, a.runs + 1) for sc in scs]; results = []
    with cf.ThreadPoolExecutor(a.jobs) as ex:
        futs = {ex.submit(run_one, sc, n, env, model, thinking, root, a.timeout): (sc['_key'], n) for sc, n in jobs}
        for fu in cf.as_completed(futs):
            k, n = futs[fu]
            try: results.append(fu.result()); print(f'done {k} r{n}', flush=True)
            except Exception as e: print(f'FAILED {k} r{n}: {e}', flush=True)
    by = {sc['_key']: sc for sc in scs}; checks = []; packets = []
    for r in sorted(results, key=lambda x: (x['scenario'], x['run'])):
        sc = by[r['scenario']]
        for t, tr in zip(sc['conversation'], r['turns']):
            res = check_turn(t['expect'], tr)
            checks.append(dict(scenario=r['scenario'], run=r['run'], turn=t['id'], checks=[dict(name=nm, ok=ok) for nm, ok in res], seconds=tr['seconds']))
            packets.append(dict(key=f"{r['scenario']}-r{r['run']}-{t['id']}", scenario=r['scenario'], title=sc['title'], run=r['run'], turn=t['id'],
                                owner_message=tr['message'], agent_reply=tr['reply'], files_produced=tr['new_files'],
                                criteria=t['expect']['response']['criteria']))
    json.dump(checks, open(os.path.join(root, 'code_checks.json'), 'w'), indent=1)
    with open(os.path.join(root, 'judge_packets.jsonl'), 'w') as f:
        for p in packets: f.write(json.dumps(p) + '\n')
    empty = sum(1 for r in results for t in r['turns'] if not t['reply'])
    if empty: print(f'WARNING: {empty} turns got no reply (API timeouts). Treat this run as incomplete.')
    tot = sum(len(c['checks']) for c in checks); ok = sum(x['ok'] for c in checks for x in c['checks'])
    print(f'code checks passed {ok}/{tot}. Results in {root}')

if __name__ == '__main__':
    main()
