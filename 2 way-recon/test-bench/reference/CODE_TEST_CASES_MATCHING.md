# 2-way recon: code test cases for order matching

For the matching code, not the agent. We agreed that matching is deterministic code, so these are unit or regression tests, not agent scenarios. Each case comes from a real order that looked like an issue and wasn't. Customers: OOOT (Square, Los Angeles) and Eggholic Schaumburg (Toast, Chicago), Sep–Nov 2026.

**Rule of thumb for the whole matcher:** any difference that no rule explains stays an issue. Nothing is cleared silently.

| # | Rule | Real example | Input | Expected |
|---|---|---|---|---|
| M1 | Toast stores the price after a discount the store funded | Eggholic: 42 orders in the week of 28 Sep | Toast `Amount` + `Discount Amount` = app subtotal | Matched (after discount) |
| M2 | Square stores the price after a discount the store funded | OOOT DoorDash 54E2637F, 21 Sep, Pasadena | DoorDash subtotal $62.88, "funded by you" −$10.00; Square order subtotal $52.88 | Matched (after discount) |
| M3 | Cancelled after the store made it, app paid (Toast) | Eggholic DoorDash 32A03F68, 6 Oct | DoorDash: subtotal $12.00, net paid $11.28, `Final order status` "Picked Up" (wrong for customer-cancelled pickups). Toast: `Voided` true, amount $0 | Matched as "cancelled, app paid". Not an issue. Toast's sales are $12 lower than DoorDash's by design |
| M4 | Cancelled after the store made it, app paid (Square) | OOOT DoorDash 0F0E7653, 22 Sep, Santa Monica | DoorDash paid $14.46; Square order `Fulfilment Status` Canceled, DOORDASH payment still marked paid | Matched as "cancelled, app paid". Square keeps the payment in its sales |
| M5 | Square names some app orders differently | OOOT "DoorDash - Storefront 4e021f22" (8 Nov), "Grubhub - Seamless 609935309462110" (13 Nov), "Uber Eats - Postmates 9E9C1" | Square `Order` field with a sub-brand between the app name and the ID | Parse the ID after any "DoorDash - Storefront", "Grubhub - Seamless" or "Uber Eats - Postmates" prefix. Storefront orders have DoorDash `Channel` = Storefront. Without this, 666 Postmates orders and 4 Storefront orders look missing |
| M6 | Grubhub number in the POS differs from Grubhub's report | Eggholic 393934949374079 (Toast shows 439034946193879), 8 Oct. OOOT 360234956540880 (Square shows 302034953331550), 9–10 Oct | No ID match | Fall back to same store, same day (Square: same day or next, see M8) and same amount (or amount after the funded discount). Pair one-to-one |
| M7 | Uber reuses its 5-character order code | OOOT A0DD9: 20 Oct $18.98 and 24 Oct $10.44, both Sawtelle (1 in about 3,700 orders) | Two different Uber orders with the same `Order ID` | Group Uber rows by `Workflow ID`, never the short code. If two POS orders share a code, pick by amount, then date. Merging them creates a false "different amount" |
| M8 | Square exports use the downloader's time zone | OOOT Uber Eats 54A39: placed 21 Sep (LA); Square `Order Date` 2026/09/22 | Square times in Asia/Kolkata | Convert to the store's time zone before matching or reporting. DST changes on 1 Nov (offset goes from 12h30 to 13h30) |
| M9 | One order on several rows (DoorDash) | Eggholic: reversal pattern, +x, −x, +x on the same `DoorDash order ID` | Three Order rows for one ID | Net them to one order |
| M10 | One order on several rows (Uber) | Eggholic Uber 720CD: two "Completed" rows, $33.70 and $0.00 | Two rows, same order | Sum to one order ($33.70) |
| M11 | App cancelled or unfulfilled, still paid, voided in the POS | Eggholic Uber D9ECF, 2 Oct: "Unfulfilled", paid $20.40; Toast voided | App status Cancelled/Unfulfilled, payout > 0 | Matched as "cancelled, app paid" |
| M12 | Store-cancelled orders, absent from the app's financial report | Toast voided tickets with no row in the app report | POS voided, no app row | Matched: nothing happened on either side |
| M13 | One Uber Eats name for several shops | Tru Nature: three shops named "Tru Nature Juice Bar" (Long Beach, Lancaster, Ocoee FL) | Same `Shop name` | Map shops by `Shop UUID`, confirmed by address |
| M14 | POS never sees app orders | Tru Nature Long Beach on Clover, 9–15 Nov: no app IDs in Clover, card and cash only, DoorDash `POS order ID` NULL for all 47 orders | No possible key | Return "order-level check not possible" with the evidence. Do not mark 80 orders as missing |
| M15 | Unknown difference | Any order no rule explains | e.g. app order with no POS ticket after M1–M14 | Stays flagged as an issue, with its type (not recorded in POS / in POS only / different amount) |

## Data-source checks before matching

| Check | Why |
|---|---|
| Use Square's **Orders** export for matching, not Transactions | Transactions misses payments taken offline. It made 60 OOOT app orders look missing |
| Toast Orders export must have **all columns** | The default view has no Tab Names, Dining Options or Voided |
| Square Sales summary filters (team members, locations) | A staff filter made one download $100K low |
| Don't use DoorDash `Final order status` to call an issue | It says "Picked Up" for customer-cancelled pickup orders |

## Expected results to regression-test against

| Customer | Period | App orders | Unexplained after all rules |
|---|---|---|---|
| OOOT (Square, 5 stores) | 21 Sep – 15 Nov 2026 | 3,876 | 0 (15 cancelled-but-paid, $280.93) |
| Eggholic Schaumburg (Toast) | 21 Sep – 15 Nov 2026 | 1,407 | 0 (3 cancelled-but-paid, $49.19) |

App sales equal POS sales to the cent for every app at both customers once cancelled-but-paid orders are accounted for. The source files are in `~/Downloads/Eval OOOT` and `~/Downloads/Eval Eggholic Schaumburg`; they contain customer names, so they stay out of any repo.
