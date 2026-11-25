# Learnings from the Ops P&L build, for the payout recon eval

From matching every delivery-app order to the POS for OOOT (Square, 5 stores) and Eggholic Schaumburg (Toast), 21 Sep – 15 Nov 2026, and checking the flagged orders in the DoorDash portal and in Square. About 5,300 app orders in total.

## 1. Headline: after the rules below, there were no unexplained differences

| Customer | App orders | Unexplained differences | Cancelled but paid (matched) |
|---|---|---|---|
| OOOT (Square) | 3,876 | 0 | 15 orders, $280.93 |
| Eggholic (Toast) | 1,407 | 0 | 3 orders, $49.19 |

App sales equal POS sales to the cent for every app at both customers. Every "issue" we flagged along the way turned out to be either a cancellation the app paid for, or a gap in our matching rules.

**What this means for the eval:** for a well-integrated store, a clean week is the normal case. The agent's main job is to say "everything matches" plainly and not invent problems. Real issues will be rare, and every one must come with its reason.

## 2. The test bench needs a fix: its "real issue" is not an issue

Test bench scenarios 01, 02 and 07 treat **DoorDash 32A03F68 (6 Oct) and 8178D310 (3 Oct)** as real issues: "voided in the POS, but DoorDash marks it picked up and paid".

The DoorDash portal shows both as **"Cancelled – Paid"**: the customer cancelled a pickup order after the store had prepared it, and DoorDash pays the store in that case. The store voiding them in Toast was correct.

- **DoorDash's detailed transactions report says "Picked Up"** for these orders. The report's `Final order status` is wrong for customer-cancelled pickup orders; only the portal is right.
- **We checked 5 such orders in the portal** (Eggholic 8178D310 and 32A03F68; OOOT 0F0E7653, E0B0B509 and 5CB33642). All 5 were "Cancelled – Paid", all were **consumer pickup**, and all were cancelled within minutes of being placed.

**What to change in the eval:**
- **Skill rule:** "cancelled or voided in the POS, but the app paid" is **not an issue**. It is a customer cancellation the app still paid for. Show it as a quiet, matched line ("N cancelled orders the app still paid"), never as a red flag.
- **Scenarios 01, 02, 07:** rewrite. With these two explained, Eggholic has no issues in either week, so scenario 01 becomes the **clean-week** scenario, which the test bench was missing.
- **New scenario:** the owner asks "Why does Toast show $24 less DoorDash sales than DoorDash paid me?" The answer is the two cancelled-but-paid pickup orders, which Toast voids to $0.

## 3. How POS systems record a cancelled-but-paid order

| POS | Order status | Sale stays in POS totals? |
|---|---|---|
| Square | Cancelled, with a DOORDASH payment marked Paid | **Yes.** The payment stays in the transaction export |
| Toast | Voided | **No.** The ticket goes to $0 |
| Clover (Tru Nature) | n/a | App orders never reach Clover |

The agent's wording should depend on the POS. For Square, "the payment stays in your Square sales". For Toast, "Toast leaves it out of its sales; the app's payment is counted here".

## 4. Matching rules learned (all deterministic)

| # | Pattern | Rule |
|---|---|---|
| 1 | POS records the price **after** a discount the store funded | Match if app subtotal = POS amount + POS discount (Toast), or app subtotal + funded discount = POS subtotal (Square) |
| 2 | **Cancelled after preparing, app paid** | Matched, shown as a quiet line (section 2) |
| 3 | **Square names some app orders differently:** "DoorDash - Storefront …" (orders from the restaurant's own DoorDash-powered website; DoorDash `Channel` = Storefront), "Grubhub - Seamless …", "Uber Eats - Postmates …" | Recognise all variants when reading the POS order name |
| 4 | **Grubhub number in the POS differs** from Grubhub's report | Fall back to same store, same day and same amount |
| 5 | **Uber reuses its 5-character order code** across different orders (OOOT: A0DD9 on 20 Oct, $18.98, and on 24 Oct, $10.44; 1 in about 3,700 orders) | Group Uber rows by `Workflow ID`, never the short code; if two POS orders share a code, pick by amount, then date |
| 6 | **One order on several rows:** DoorDash charge, reverse, charge again; Uber two "Completed" rows | Net or sum to one order |
| 7 | **Time zones:** Square exports and its web view use the downloader's time zone (India), so a Los Angeles afternoon order sits on the next day's date | Convert to the store's local time before matching or reporting; give the next-day date when telling someone where to look in Square |

Each rule came from an order that looked like an issue and wasn't. New quirks will keep appearing with new customers. The eval should check that the agent **does not clear an unknown difference silently**: it stays red until a rule explains it.

## 5. Data-source traps (wrong inputs that look right)

| Trap | What happens | Fix |
|---|---|---|
| **Square Transactions export is incomplete** | Payments taken offline (often around opening time) are missing. It made 60 OOOT app orders look missing | Use Square's **Orders** export for matching (ID + status); use Transactions for payments and fees |
| **Square Sales summary with a staff filter** | Our first download had "10 of 25 team members" selected, $100K lower than the real total | Check the report's team-member and location filters before comparing totals |
| **Toast Orders export shows only visible columns** | The default 10 columns have no Tab Names, Dining Options or Voided | Turn on "Show all" columns before exporting |
| **DoorDash `Final order status`** | Says "Picked Up" for customer-cancelled pickup orders | Don't use it to call an issue; the portal shows the truth |
| **DoorDash payout includes staff tips** | Payout-based "net after fees" is higher than sales minus fees (Tru Nature: $158 of tips over 8 weeks) | Build net after fees from the fee lines, or remove tips |
| **One Uber Eats name for several shops** | Tru Nature has three shops called "Tru Nature Juice Bar", one of them in Florida | Map shops by `Shop UUID`, confirmed by address in Uber Eats Manager |

## 6. When order-by-order recon is impossible

**Tru Nature (Clover):** app orders never reach the POS (the tablets aren't linked). We tested this rather than assuming it:
- **No app IDs** anywhere in Clover.
- **No app payment types:** card and cash only.
- **DoorDash `POS order ID` is empty** for every order.
- **Time-and-amount match at chance level:** 29 exact matches within 20 minutes at the true times, against 34 and 21 with times shifted by 2 hours. That's what coincidence produces, not a pattern.

**What the agent should do:** say the check isn't possible and why, reconcile totals where it can, and suggest linking the tablets. **Eval scenario:** "POS does not record app orders", where the agent must not report every app order as missing.

## 7. Other things worth knowing

- **Store-cancelled orders mostly don't appear** in the app's financial report, because the app doesn't pay, so they show as "cancelled in POS, absent from app report". That's matched: nothing happened on either side. DoorDash's "Cancelled Long Fulfillment Time" (the store was too slow) still pays most of the order.
- **Card fees by POS:**
  - **Square:** per payment, in the Transactions export.
  - **Toast:** in "Settled deposits daily breakdown" by sales date. Its card payments equalled Toast's credit and debit total to the cent.
  - **Clover:** only in the monthly processing statements from the processor (Swipeport/Fiserv), and only on logins that can see them.
- **Own online ordering** can sit outside the POS: Tru Nature's ChowNow orders don't reach Clover. A sales check needs that channel too.

## 8. Suggested additions to the test bench

1. **Clean week** (rewritten scenario 01): all apps match. A one-line summary, no false flags, the cancelled-but-paid count only if asked.
2. **"Why is Toast lower than DoorDash?"** Explained by cancelled-but-paid pickup orders.
3. **Naming variants:** a Storefront or Seamless order must not be reported missing.
4. **Uber code reuse:** two orders with the same code must not merge into a "different amount".
5. **POS doesn't record app orders** (Tru Nature): say the check isn't possible.
6. **Owner disputes a flag:** "Our POS says that order was cancelled." The agent explains it's a customer cancellation the app paid for, and points to the app's portal to confirm.

## 9. Added 24 Nov: HolyShred Geary (Square, delivery apps only)

1,573 DoorDash and Uber Eats orders checked against Square's orders export. 59 looked wrong at first; none are left.

| # | Pattern | Rule |
|---|---|---|
| 8 | **Uber free-item offer** (43 orders). Square shows the free item at $0, so its subtotal is lower than Uber's sales by the item's price | Square = sales − free item price. Read the free item from Square's item lines (price > 0, total 0) |
| 9 | **Free item plus a percent-off offer.** The percent discount is spread over every item, and the free item's share of it is dropped | Square = sales − F − (offer − F) × (1 − F ÷ sales), where F = free item price and offer = Uber's "Offers on items" less its tax. Exact to the cent on all 43 |
| 10 | **Catering orders never reach the POS** (12 orders, $4,380). DoorDash marks `Channel` = Catering. On Uber Eats all 10 were at the 20% marketplace rate, $283–$467 | Show as "Catering, not sent to POS", not as missing. The Uber marker is a pattern we saw, not a field Uber labels |
| 11 | **DoorDash `Final order status` can say "Cancelled Paid"** outright (1 order here), as well as the mislabelled "Picked Up" | Use it when present |

| 12 | **Uber reuses a code, and Square keeps both orders under the same name** ("Uber Eats 1E54B" on 12 Oct and 22 Oct) | Key POS orders by name + receipt number, never by name alone. Our first pass keyed by name, dropped the second order and reported a false "missing in POS" |
| 13 | **App cancelled it unpaid, but the POS shows it completed** (DoorDash DE02E3DC, 6 Oct, $17.94). Auto-accepted through the integration at 1:28 pm, no courier ever assigned, marked Completed in Square at 2:04 pm, cancelled by DoorDash at 2:40 pm as "Store closed", Paid = false. Geary seems to stop taking orders about 2–5 pm | Not a payout error. Source: DoorDash **Operations Quality → Cancelled orders** report (Paid flag, cancellation reason). Warning sign in the POS: a delivery marked Completed with no courier in its notes. Show as "Cancelled by the app, not paid" and ask the store whether the food was made |

**DoorDash reports worth knowing:**
- The **Client Order ID** in DoorDash's Operations Quality reports ends with the POS's own order ID (Square's order page ID). That is an exact join, with no code matching.
- The **Orders page keeps only 30 days**, but **reports can still be downloaded for older dates** (6 Oct was downloaded on 25 Nov). Use the cancelled-orders report to explain POS-only orders after the fact.

| 14 | **Buy-1-get-1 on several pairs: the POS records only one free item** (DoorDash 1D117DE3, 27 Oct). 4 sides at $5.69: DoorDash discounted 2 ($11.38, funded by the store through a Smart campaign); Square recorded 1 ($5.69), so Square's subtotal is $5.69 higher | DoorDash discount ÷ Square discount = a whole number of free items → matched, with a note that the POS sales are overstated. Proof: Square's own tax ($22.01 = 8.625% × $255.16) was worked out on the full DoorDash discount |
| 15 | **DoorDash charge, reverse, re-charge on the same order** (same order, 12:27 pm): the re-charge taxed the full subtotal, so the store's net moved by +$0.98 | Net the three rows to one order; not a sales difference |

**Result:** all 1,573 HolyShred Geary orders are explained. With OOOT and Eggholic, about 6,900 orders across three customers have no unexplained differences. For the eval, every scenario built from these customers is a "clean once you know the rules" case, and the value is in giving the reason for each.

**Data note:** HolyShred's Square has app orders only (no till, one location), and its QuickBooks has monthly totals only. In-store sales need another system.

## 10. Added 25 Nov: ghost orders (OOOT, July 2026)

Checked every DoorDash order at OOOT's 4 app stores: Toast for 27 Jun – 27 Jul (986 orders) and Square for 29 Jul – 4 Aug (262 orders). Everything matched except **3 ghost orders, $40.89**:

| Order | Store | When (Pacific) | POS | DoorDash |
|---|---|---|---|---|
| CC78C7BF | Koreatown | 14 Jul, 5:16 pm | Toast: completed, $9.45 | Cancelled 2 s after placing, "Other", not paid. No reorder |
| 28D20B15 | Sawtelle | 26 Jul, 2:22 pm | Toast: completed, $21.00 | Cancelled 1 s after placing, "Other", not paid. Same order placed again 19 min later, delivered |
| 30653CDD | Santa Monica | 3 Aug, 12:04 pm | Square: payment "Complete", $10.44 | Cancelled 1 s after placing, "Other", not paid. Same order placed again 7 min later, delivered |

| # | Pattern | Rule |
|---|---|---|
| 16 | **Ghost order:** DoorDash cancels within seconds, but the POS accepts it after the cancel (DoorDash's own report shows the cancel timestamp before the POS confirmation) and keeps it as a sale | Source: DoorDash Operations Quality → Cancelled orders. Flag when Paid = false, minutes to cancel < 1, category "Other", and the order is in the POS as completed. Payout is right; POS sales are overstated; ask whether the food was made |
| 17 | **OOOT moved app orders from Toast to Square on 29 July** for all 4 stores (DoorDash's Merchant delivery ID changes from a bare UUID to "MLY8…:…"). In-store sales moved earlier (27 Jun) except Koreatown (29 Jul) | Pick the POS by date; a POS change mid-month splits the check |
| 18 | DoorDash's file can lose leading zeros on order IDs ("7872634" for 07872634), likely from a spreadsheet save | Pad DoorDash order IDs to 8 characters before matching |

Other July cancellations behaved as expected: 3 cancelled-but-paid orders voided in Toast (BA6F7403, 29015A86, and 262729B4 at $0), and unpaid store-side cancellations voided in Toast or never sent to it.

## 11. Added 25 Nov: summary of the real cases, with explanations

Every case below has a deterministic explanation; none is a payout error. Use them as eval scenarios: the agent must give the reason, not just flag the order.

### HolyShred Geary (21 Sep – 15 Nov 2026)

| Order | Looked like | What happened | Impact |
|---|---|---|---|
| Uber Eats 1E54B, 22 Oct, $31.36 | Missing from Square | Uber reused the code (also 12 Oct). Square kept both orders under the same name; our matching dropped the second | None. Match POS orders on name + receipt number |
| DoorDash DE02E3DC, 6 Oct, $17.94 | Completed in Square, not paid by DoorDash | Auto-accepted at 1:28 pm while Geary was still open on DoorDash. The store then seems to have closed for its afternoon break (about 2–5 pm) before the order went out. No Dasher assigned; Square marked it complete at 2:04 pm; DoorDash cancelled at 2:40 pm, "Store closed", unpaid. Customer reordered at 3:30 pm, picked up only at 5:03 pm | Payout correct. Square sales $17.94 too high. Possible wasted food. Fix: DoorDash hours should match the real break, or pause DoorDash before closing. Confirm with DoorDash's store availability/downtime history |
| DoorDash 1D117DE3, 27 Oct | DoorDash $266.54 vs Square $260.85 | Buy-1-get-1-free on 4 sides at $5.69: DoorDash discounted 2 ($11.38), Square recorded 1 ($5.69). Square's own tax was worked out on the full $11.38 | Payout correct. Square sales $5.69 too high |

By design, not gaps: 12 catering orders ($4,380) never reach Square; 6 orders were cancelled but paid.

### OOOT, July 2026: ghost orders

1,248 DoorDash orders at 4 stores (Toast to 28 Jul, Square from 29 Jul). No missing orders, no wrong amounts, 3 ghost orders:

| Order | Store | When (Pacific) | POS | Kitchen (Toast → Kitchen operations → Ticket details) | Reorder |
|---|---|---|---|---|---|
| CC78C7BF | Koreatown | 14 Jul, 5:16 pm | Toast: completed, $9.45 | Made, fulfilled 5:19 pm by staff | None |
| 28D20B15 | Sawtelle | 26 Jul, 2:22 pm | Toast: completed, $21.00 | Made, fulfilled 2:33 pm by staff | Same customer at 2:41 pm, made again |
| 30653CDD | Santa Monica | 3 Aug, 12:04 pm | Square: Complete, $10.44 | Not checked | Same customer, 7 min later |

DoorDash's cancelled-orders report for all three: cancellation "Other", non-payment reason **"Mx Did Not Confirm"**, Paid = false.

**Why it happened:**
1. DoorDash sent the order to the POS, then cancelled it 1–2 seconds later, reason "Other". The quick reorders suggest a checkout or payment failure.
2. The POS takes about 1–2 seconds to create an incoming order. The cancel arrived inside that window, before the order existed in the POS, so it had nothing to attach to and was missed. DoorDash did not send it again.
3. The POS then created and confirmed the order a second after the cancel. DoorDash pays a cancelled order only if the store confirmed first ("Mx" = merchant), so it marked these "Mx Did Not Confirm" and paid nothing.
4. The order showed on the kitchen screen like any paid order, staff made it, and the POS kept it as a sale.

Seen on both Toast and Square, so the timing gap is on DoorDash's side. Cancellations minutes later were voided correctly in the POS (7A3E9496 after 21 min, BA6F7403 after 76 min).

**Impact:** POS sales $40.89 too high; food made and unpaid in at least 2 cases. Possibly disputable: DoorDash's report shows the POS confirming after the cancel, and the kitchen ticket proves the order was made.

**Confidence:** the timestamps (DoorDash report) and kitchen tickets are facts. That the cancel was missed because the order did not exist yet is an inference from the timestamps; the POS integration log for the order would confirm it.

### How the agent catches these

| Case | Rule |
|---|---|
| Ghost order | DoorDash cancelled-orders report: under 1 minute to cancel, "Other", "Mx Did Not Confirm", POS confirmation after the cancel. POS has it completed. Proof it was made: the POS kitchen ticket |
| App cancelled unpaid, POS shows completed | Same report: Paid = false with a store-side reason (for example "Store closed"). POS: a delivery with no courier recorded |
| Promo recorded differently | App discount ÷ POS discount = whole number of free items |
| Reused codes | POS orders keyed by name + receipt; Uber by Workflow ID |
| "Mx Did Not Confirm" in general | Means only "cancelled before the store confirmed". It also appears on orders the POS rejected or the customer cancelled early; those never reach the POS and need no action |

**Main extra source:** DoorDash Operations Quality → Cancelled orders. It explains every POS-only order, can be downloaded past the 30-day Orders-page limit, and its Client Order ID links to the POS order. Run the check at least weekly so gaps can still be disputed.
