# KoreFi chargeback dispute playbook

Source: "Chargeback Dispute Procedure", DoorDash · Uber Eats · Grubhub, internal operations (shared by the KoreFi ops team, 2026-11-11).
Follow it on every case. Where it gives a template, adapt the template to this order's facts; never paste a bracket placeholder the case can fill.

## Store standard practices (state these as fact)

Every store KoreFi works with follows these practices. State them plainly in drafts:
- 2-step check: items, quantity and customizations are confirmed before packing and again before courier handoff.
- Wastage log: wastage is recorded. "No [item] wastage recorded on [order date]" may be stated for the item in question.
- Regular quality assessment tests.
- Inventory is replenished with fresh ingredients regularly, so there is no chance of ingredient degradation.
- Standardized preparation procedure with fixed ingredient ratios.
- Hygiene: all kitchen staff wear masks, caps and gloves at all times.

Use the 2-step check for quantity claims (missing items) only. It does not answer a quality claim.

## Error types: strongest arguments

Win rates are the team's estimates. Use them only to choose an approach; never show them to the operator or put them in a draft.

| Error type | Strongest arguments | Watch out for | Win rate |
|---|---|---|---|
| Missing item (most common) | 2-step check (before packing and before handoff). No food wastage recorded. Several items missing at once is implausible. Item is a core component. Other items from the same batch were not reported. No photo submitted. | Returning or top customers carry more weight with the reviewer. | ~78% |
| Wrong / incorrect item | Order ticket contradicts the complaint. Item is not in the menu description. Customer confused similar items. The modifier was never in the order. Customer photo has no order label. | A clear substitution photo: go goodwill instead. | ~55% |
| Food quality (undercooked, unsafe to eat) | Regular quality assessment tests. Fresh ingredients replenished regularly. Late courier pickup means quality degraded after handoff. Standardized procedure. Other items from the same batch not reported. Food half-consumed before the complaint was filed. Item-specific impossibility (a visual doneness indicator). | The 2-step check covers quantity only, not quality. | ~60% |
| BOGO / discount misunderstanding | Order ticket shows only X quantity ordered. The discount was a reward, not BOGO. We prepared exactly what the ticket shows. | Nothing: the order record is definitive. | ~100% |

## Dispute decision framework

1. Did the customer submit photographic evidence? No photo: dispute with full confidence. A clear substitution photo (for example chai instead of lassi, the wrong item plainly visible): take the goodwill path instead. A photo showing the food half-consumed: use it as a counter-argument in the dispute.
2. Does the complaint match what was actually ordered? Check the complaint against the order ticket. Complaints about items that were never ordered (a wrong modifier, a misread discount, an unlisted component) are the strongest disputes. The order record is definitive.
3. Missing item: both checks were done and no wastage exists for that item on that date. This is the baseline argument for missing items.
4. What is the customer's credibility profile, as the page shows it? A top customer with many prior orders: reviewers lean toward them, so adjust the tone. A first-time customer: mention it. High loyalty and a small charge: consider goodwill.
5. Was the courier pickup significantly late? A late pickup (10+ minutes) shifts quality responsibility to the delivery chain. On every food quality dispute, note the quoted and the actual pickup time if the page shows them.

## Highest-converting arguments (templates)

- **2-Step Verification** (highest win rate): All items verified through our 2-step check: items, quantity and customizations confirmed before packing and again before courier handoff. For an item to be missing, it would need to fail two independent verification stages.
- **No Wastage Record** (strong corroboration): No [item] wastage recorded on [date], confirming all portions were dispatched. No waste log entry means the item was prepared and sent.
- **Core Component Logic** (missing items): [Item] is a core component of this dish, not an optional add-on. It cannot be assembled or plated without it, so its omission is operationally implausible. Example: curry reported missing from a one-item order of curry with a naan customization.
- **Batch Logic** (boba / multi-item orders): All items were prepared identically from the same batch at the same station. Only one was reported. An error affecting one but not the others is inconsistent.
- **Late Courier Pickup** (quality disputes): The item was ready at the quoted pickup time [X]. The courier arrived [Y] minutes late. Any quality degradation occurred after handoff, outside our custody and control.
- **Complaint Contradicts Order** (wrong item / modifier): The customer's complaint references [item/modifier], which was not part of this order. This factual inaccuracy undermines the reliability of the whole claim.
- **Menu Description vs Platform Image** (undocumented components): [Item] was fulfilled as per the documented menu description, which does not list [component]. Expectations set by platform imagery are not a fulfillment obligation.
- **Food Half-Consumed Before Complaint** (unsafe / quality claims): The customer's own photo shows the item partially eaten, with utensils in it, before the complaint was raised. Food that was unsafe to eat would not be partly eaten first.
- **Item Physically Impossible to Undercook** (specific items): [Item] has a visual doneness indicator built into its preparation. For example, bhature puffs only when fully cooked; an undercooked one would not puff and would be obvious before serving.
- **Foreign Object Not From Kitchen** (safety complaints): Our kitchen follows strict hygiene protocols: all staff wear masks, caps and gloves at all times. [Object] could not have come from our kitchen. For staples: staples are used only on the outer packaging, never in food preparation, so one may have dropped in while the parcel was opened.
- **Packaging Mismatch = Delivery Mix-Up** (wrong order claims): The container in the customer's photo does not match our packaging. This is a courier delivery mix-up. Our kitchen prepared and packed the correct item.
- **Weight / Volume Makes Omission Implausible** (large or multi-item missing): The reported missing items are the entire substance of the order. A bag missing [X full combo meals] would show an obvious difference in weight and volume at both verification checkpoints.
- **Customer's Own Statement Confirms the Item Left the Store** (missing item): The customer's own statement confirms the item was visible at pickup. This is not a packing error: the item left our store with the courier, and any loss between pickup and delivery is the courier's responsibility.
- **Mid-Delivery Courier Swap = Chain of Custody Gap** (Uber Eats): This order had two courier assignments. A mid-delivery handoff outside our control creates a chain-of-custody gap we cannot be responsible for. All items were verified before the first pickup.
- **Commission Charged on Cancelled Order** (Grubhub): The order was cancelled and never fulfilled. The customer refund is understood, but Grubhub deducted commissions and fees on an order that generated zero revenue and was never delivered. Charging commission on an unfulfilled, cancelled order is not justified.
- **Modifier Was a Free-Text Note, Not a Selectable Option** (wrong ingredients): The customer's request was a free-text note acknowledging that no menu option existed, not a selectable modification. An item that cannot be selected on the menu is not a verified order modification.

## Goodwill path: when the evidence is on the customer's side

Do not dispute; ask for a goodwill reversal instead. Reviewer credibility is finite: a weak dispute on a $3 charge can colour how reviewers read a stronger $37 dispute filed the same week.

Use goodwill when:
- the customer submitted a clear photo showing the wrong item;
- the customer is a top or loyal account;
- the error is operationally plausible and there is no counter-evidence.

Goodwill template (acknowledge the feedback, commit to a process improvement, ask for the reversal, never admit fault):
> We take this feedback seriously. We have reviewed our [packing/beverage] process and are implementing additional scrutiny at the handoff stage to prevent recurrence. As a restaurant committed to quality, we respectfully request a goodwill reversal of the $[X] charge. We value our standing on the platform and our customers' experience.

## Evidence to attach, by error type

Tell the operator what to attach (in missing_evidence). The operator attaches it; never claim it is attached.

| Error type | Attach this | Impact |
|---|---|---|
| Missing item | POS / kitchen completion record, order ticket | High: proves the item was prepared |
| Wrong item | POS order ticket | High: visual proof of correct preparation |
| Food quality | Courier timeline screenshot (can only be mentioned) | Medium: shifts blame to transit |
| BOGO dispute | Order details showing the quantity and the discount type | Definitive: the order record is proof |
| Customer photo claim | (nothing specific) | Medium: challenges the photo's link to the order |
| Appeal (denied dispute) | Any available evidence, plus a screenshot from the platform's order panel | Essential: platforms require evidence on appeal |

## What each draft contains

Draft length: DoorDash 500 characters, Uber Eats 400 characters, Grubhub longer texts (and Grubhub has no evidence upload).

- **Missing item**: the order, what is reported missing, the 2-step check, no wastage recorded for that item on that date, the customer's history (first-time, or top customer with years and order count, if the page shows it), and the courier pickup if it was late.
- **Food quality**: lead with the late pickup shifting responsibility after handoff (quoted against actual pickup time, minutes late), then standardized preparation with fixed ingredient ratios.
- **Goodwill request**: what the customer's photo claims and the charge amount; acknowledge the feedback, commit to a process improvement, request the reversal without admitting fault.
- **BOGO / discount misunderstanding**: what the customer claims was missing, the quantity the ticket shows was ordered, and the discount type (reward or BOGO) and whether it applied to this item: the customer misunderstood the promotion; it was not a fulfillment failure.

## Appeals: when a dispute is denied

Platforms sometimes offer an option to appeal a denied chargeback. It is easy to miss.
- **Leave it** when the ticket value is low or the error is evidently the restaurant's mistake. Appealing a weak case wastes credibility and reviewer goodwill.
- **Appeal it** when the ticket value is large, the original logic was sound, and the denial came without clear counter-evidence.

On appeal the core logic stays the same. Add:
- More emphasis on QA and operational standards: not just that we checked, but that our standards make the error structurally unlikely.
- A customer-experience angle, especially for new customers: we value this customer and would never deliver something that affects our reputation. Brief and genuine, not defensive.
- Something attached. Platforms require evidence on appeal. Use POS records if there are any; otherwise a screenshot from the platform's own order panel, so the message reaches the reviewer.

Real example, order 3401C156 (DoorDash): the customer complained of missing items, stale and oily curry and burnt parathas. Disputed with the 2-step check for the missing items, and QA and standardized-procedure logic for the rest: denied. Appealed with the same core arguments, stronger QA emphasis, and a note that the customer was new and we take first impressions seriously. A screenshot of the item image from its DoorDash page was attached because no POS record, CCTV or kitchen photo was available. Recovered $22 of the $37.17 charge.

## Grubhub: portal and email together

After denying a dispute, Grubhub support once said disputes can be escalated by email as well as through the portal. Since then, the team files Grubhub disputes in the portal as normal AND sends the same case by email at the same time. This dual-channel approach has produced better outcomes than portal-only submissions; the email is a second touchpoint and signals urgency, especially on higher-value cases.

Grubhub email: turn the portal dispute text into a short professional email with a subject line, a brief context intro, the dispute arguments and a clear ask for reversal, under 200 words in total.
