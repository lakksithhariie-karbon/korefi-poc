# Dispute agent testbench

The run matrix selects three curated PostgreSQL scenarios. The full catalog also includes additional real captures and controlled variations.

| Scenario | Expected sidebar output |
| --- | --- |
| DoorDash missing item | Dispute for a $15.58 charge covering two missing items, with a draft within 500 characters |
| Uber Eats wrong item | Goodwill for a $6.12 wrong-item charge, the verbatim comment, and a draft within 400 characters |
| DoorDash already credited | Don't dispute, an explanation of the $9.59 credit, and no draft or customer quote |

`scenarios/*.yaml` pairs the evidence and optional query with the expected result and grading rubric. A null query uses the sidebar's **Check this charge** message. `fixtures/` holds selected portal text and customer photo fixtures. The original Uber Eats cola photo and DoorDash packaging photo stay local and must be supplied separately on another machine. Optional `customer_photos` and `screenshots` list fixture filenames. Photos go first.

The fixtures keep the captured amounts, issue details, portal notices, and first operator message. Order IDs are aliases. Portal screenshots and unrelated personal details are omitted. These are curated replays. For the Uber Eats and credited DoorDash cases, the latest database case row was updated after the first answer. The Uber Eats photo and DoorDash approval and refund evidence were available in the first-turn images. Expected grades are defined by the rubric.

`matrix.yaml` selects the cases, fixture source, repeat count, and Cursor judge timeout. Each repeat calls the same `investigate()` function as KoreFi with a fresh transcript and empty history. The runner uses the service's normal provider and model selection. With a gateway key, the default is Muse Ember, subject to the same environment override as the service. The cases exercise the agent and its structured answer. Browser capture, sidebar rendering, and production persistence are outside this testbench.

The runner checks exact fields, response structure, and draft limits in code. Cursor Grok 4.7 High grades the rubric against the evidence and the sidebar result in a fresh, restricted temporary workspace. A failed check, unassessable criterion, or runner error prevents a passing grade. The text-only Cursor invocation was smoke-tested before this suite was written. The suite and the photo path still need their first run.

## Run when ready

Use the project's Node runtime, installed backend dependencies, configured agent provider, and an authenticated `cursor-agent` available on PATH with `grok-4.7-high` enabled. The runner reads the project-root `.env` if present and honors existing environment settings.

From this folder:

```sh
npm install
npm run eval
```

The matrix currently makes three attempts per scenario. Each run writes a JSON report immediately and the suite writes a summary under `results/`. A judge timeout or malformed grade is recorded as a judge error. Running the suite calls both model providers with the specified fixtures.

## Scenario catalog

The catalog covers DD-01 through DD-09, UE-01 through UE-07, and SH-01 through SH-15. Filenames start with the platform. Each YAML file includes its coverage ID and fixture source. Shared scenarios have a separate file for each live platform. Separate variants cover near and expired deadlines, clear and unclear photo evidence, present and absent customer comments, and starter and custom queries.

The catalog contains 52 files. The `source` field records how each input was assembled.

| Source | Cases | Meaning |
| --- | ---: | --- |
| `PostgreSQL DB` | 10 | Selected evidence from saved runs or captures, with order aliases and unrelated details omitted. |
| `PostgreSQL DB (adapted)` | 36 | Actual charge, order lines, query, or photo combined with a controlled change described in `input_notes`. Examples include an open route for the packaging photo and a scripted POS follow-up. |
| `synthetic` | 6 | Controlled cases without a matching captured input. These cover an offered appeal, unclear photo, Uber Eats no-order and pickup flows, partial quantity, and wrong customization. |

The run matrix still selects the three original cases. First-turn agent cases use the current runner's input and expectation fields. Three extensions to the scenario format describe cases that need additional runner support:

| Field | What a future runner needs to do |
| --- | --- |
| `follow_ups` | Resume the conversation with the saved transcript and current draft. Apply each turn's query and optional `additional_text`. Check the visible answer and whether its draft was preserved, revised, or shortened. |
| `input.history` | Return the listed fixture rows from the named history methods. |
| `entry_point: sidebar_capture` | Exercise the no-order capture path and verify the sidebar guidance and that the agent was never called. |

Keep these cases out of the first-turn matrix until the runner supports their entry points.
