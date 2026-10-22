# PayPal AI Hackathon: Three Concepts to Win

**Prepared:** Thu Oct 22, 2026 · **Deadline:** Nov 12, 2026, 12:00 PM PST = **Nov 13, 1:30 AM IST** · **Days left: 21**
**Treat the evening of Nov 11 (IST) as the real deadline.**

> **How to read this file.** Rules, prizes and sponsor details come from the Devpost pages and PayPal docs I read during research. Anything marked **VERIFY** is something I could not confirm and your team must test early. Ratings and recommendations are my judgment, not data. None of these ideas has been validated with real users yet. Step 1 of every plan is to do that.

---

## 0. The hackathon on one page

| Item | Detail |
|---|---|
| Must do | Build or significantly update an app that **meaningfully** uses PayPal (free sandbox) **and** AI. No tracks. |
| Submit | Text description · working demo (hosted URL **or** full run instructions in repo; mockups don't count) · public repo with visible open-source license · YouTube demo under 3 min · list of tools and how they were used |
| Judging | Stage 1: pass/fail on theme fit and real use of PayPal APIs. Stage 2: five **equally weighted** criteria: Technological Implementation, Design, Potential Impact, Innovation/Idea, Presentation |
| Tie-break | Higher score on the first criterion listed = **Technological Implementation**. Depth beats breadth. |
| Judging may use | Panels, peer review and **automated AI analysis**. Write a README a machine and a human can both follow. |
| Grand prizes | 1st $12k · 2nd $8k · 3rd $5k |
| Honorable ($5k each) | Most Creative · Most Impactful · Best Demo Delivery · Best Use of PayPal + AI · Best Use of Agentic Commerce |
| Sponsor prizes | AG Grid $5k/$2k/3×$1k · Channel3 $1.5k · Bryntum 3×$1k · APIMatic 3×($1k + 6 mo subscription) · Render credits $1k/$750/$500 |
| No sponsor prize listed | Astropods, Elastic, KERNEL, Postman, Zapier (tools and credits only) |
| Stacking | One project can win **one** Grand Prize **or** one Honorable Mention, **plus one** Sponsor Prize. You're considered for the sponsor prize of every tool you use. |
| Dates | Judging Dec 1–15 · winners about Dec 21 |
| Team | No size limit. One adult **Representative** submits, receives the prize and divides it. |

---

## 1. Choosing between the three

| Criterion (my judgment) | A: Mandate | B: Runway | C: ProofPay |
|---|---|---|---|
| Fit with "agentic commerce" prize | **High** | Low–Med | Med |
| Technological depth (also the tie-break) | **High** | Med–High | High |
| Real user credibility | Med (niche wedge) | **High if users are on PayPal** | Med–High |
| Novelty / not crowded | Med (many shopping agents; guardrails are the differentiator) | Low–Med (invoice tools exist; the payment-aware timeline is the differentiator) | **High** |
| Sponsor coverage (real, not decorative) | 8–9 of 10 | 7–8 of 10 | 8–9 of 10 |
| Feasibility in 21 days | Med (autonomous payment spike, see A.4) | **High** | Med (Payouts + vision) |
| Demo-ability in 3 minutes | **High** (attack demo) | Med–High | **High** (proof-to-payout flow) |

**My recommendation: Mandate (A) as primary.** It targets the most prizes at once (Agentic Commerce, PayPal + AI, Most Impactful, plus AG Grid, Channel3, Render, APIMatic) and has the strongest technical story. Choose **Runway (B)** if your team is stronger at frontend/product than at agent safety engineering. Choose **ProofPay (C)** if you want to bet on Impact and Creativity and can handle more moving parts.

**Decide by tomorrow evening (Oct 23).** Before you commit, each of you answers these in writing for your chosen idea:

1. **Who exactly is the user?** Name five real people you can interview this week.
2. **What do they do today,** and what does it cost them (time, money, risk)?
3. **Why is your solution better** than the best existing alternative? Look up what exists first. Several payment networks and protocols are already pushing agent payments.
4. **How will success be measured?** Use the metrics in each section.
5. **What is the weakest assumption,** and what is the cheapest test of it?

---

## 2. Shared foundation (all three ideas)

### 2.1 Core design principle: the LLM proposes, code decides
Never let the model be the only thing standing between a prompt and a money movement. The LLM parses, ranks, drafts and explains. **Deterministic code** enforces amounts, caps, allowed payees, rate limits and approvals. This is both your safety story and your Technological Implementation story.

### 2.2 Suggested stack
Pick what your team already knows. The PayPal Agent Toolkit supports TypeScript and Python and plugs into the OpenAI Agents SDK, LangChain, CrewAI, Vercel AI SDK, Bedrock and MCP.
- **Backend:** TypeScript (Next.js route handlers or Fastify) or Python (FastAPI).
- **Frontend:** React/Next.js (AG Studio and Bryntum both have React support).
- **LLM:** any with function calling and structured output. Add schema validation (Zod/Pydantic) on every model output.
- **Hosting:** Render (web service + Workflows).

### 2.3 Repo skeleton
```
/apps/web            # UI
/apps/api            # agent service, policy engine, webhooks
/packages/policy     # pure functions, 100% unit-tested
/packages/evals      # scenario suite, runners, results/
/docs                # architecture.md, sponsor-usage.md, results.md
/scripts             # seed data, sandbox setup
LICENSE              # Apache-2.0 or MIT, visible in the repo About section
.env.example         # names only, never values
README.md            # setup, architecture, tools used and how, metrics, limits
```

### 2.4 Evaluation harness (build it in week 2, not week 3)
- A **scenario suite** (30–60 cases) with expected outcomes, including adversarial ones.
- A **baseline** to beat (for example, an LLM with raw tools and no policy layer).
- Metrics reported as **counts and rates**, with the exact conditions. State sample sizes plainly. Small N is fine if you say so.
- A **held-out attack/test set** you do not tune prompts on. This is your data-leakage check.
- A `results.md` with a failure analysis: where it failed and why.

### 2.5 Security and secrets
- Sandbox only. Never commit keys, trial license files or tokens. Use `.env.example`.
- Put sandbox buyer/test credentials for judges **in the submission's testing instructions,** not in the repo. Rotate them after judging.
- Paid-library trial keys (AG Studio, Bryntum) must never land in the public repo.

### 2.6 Sponsor onboarding (do this Oct 22–23)

| Sponsor | How to get access |
|---|---|
| **PayPal** | developer.paypal.com account + sandbox. AI Toolkit: github.com/paypal/AI-Toolkit · docs.paypal.ai · sandbox guide: github.com/paypaldev/getting-started-with-paypal-sandbox · Postman collection: postman.com/paypal. If sign-up fails in your country, ask on the PayPal Discord. |
| **AG Grid** | Free 45-day trial license (ag-grid.com/studio) + PayPal boilerplate: github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate |
| **APIMatic** | Claim the free subscription via the form linked on the APIMatic sponsor page; Context Plugin for PayPal (PayPal is pre-enabled, no extra credentials) |
| **Bryntum** | bryntum.com/download, 45-day trial. For Scheduler: `npm install @bryntum/scheduler@npm:@bryntum/scheduler-trial` (check the download page for the Gantt/Calendar equivalents). |
| **Channel3** | trychannel3.com/developers, promo code `PAYPAL-HACKATHON-2026` for 20,000 credits; MCP: trychannel3.com/mcp |
| **Elastic** | ela.st/elastic-paypal-hackathon (14-day trial, extendable 30 days) **or run Elasticsearch locally for free** |
| **Render** | $50 credits via the claim link on the Render sponsor page; Workflows docs: render.com/docs/workflows |
| **Zapier** | Sign up at zapier.com (14-day Pro trial, then Free); MCP docs: docs.zapier.com/mcp |
| **KERNEL** | $50 credits via the link on the KERNEL sponsor page |
| **Astropods** | astropods.com, free account; docs.astropods.com |
| **Everyone** | Join the PayPal Discord; every sponsor team answers hackathon questions there |

**Trial-clock warning.** AG Studio and Bryntum trials are 45 days, and Elastic's is 14 (+30). Judging runs to Dec 15, and the rules require your project to stay available until judging ends. **VERIFY on Discord** how each sponsor handles trials that expire mid-judging. Make the repo run against local Elasticsearch, and make the demo video your primary evidence.

---

## 3. IDEA A: **Mandate** — spending guardrails for AI agents

> *Let an agent buy things for your team without handing it your wallet.*

### A.1 User and problem
**Hypothesized user:** the treasurer or ops lead of a small team that makes frequent small purchases: student societies, clubs, early-stage startups, community groups. **This is a hypothesis; validate with five interviews.**

**Problem:** delegating purchases to an AI agent is risky. Wrong item, price changed between search and checkout, double charge, no audit trail, and **prompt injection through product text** (retailer-supplied titles and descriptions are untrusted input feeding an agent that controls money).

**Our claim (to be proven by the eval, not asserted):** a policy layer that sits outside the LLM stops attacks a naive agent falls for, at an acceptable false-block rate.

### A.2 What we build

**MVP (must ship):**
1. **Mandate setup:** budget, per-category caps, per-item cap, auto-approve threshold, approver, allowed categories/domains, expiry.
2. **Request intake:** natural language → structured purchase intent (item, qty, needed-by, max price), schema-validated.
3. **Search and shortlist** via Channel3 with the model's reasoning shown to the user.
4. **Policy engine (pure code):** returns `ALLOW`, `NEEDS_APPROVAL` or `DENY` with machine-readable reasons. Checks include cart total, per-item cap, category, budget remaining, price drift since quote, currency match, duplicate request/replay, and **split-purchase structuring** (many small buys to dodge a cap).
5. **Payment** through the PayPal Agent Toolkit (see A.4 for the autonomy caveat).
6. **Human approval** over Zapier MCP (Slack or email). The agent resumes from a durable workflow when the approver responds.
7. **After purchase:** shipment tracking, refund and dispute handling.
8. **Audit trail + dashboard:** every agent step logged; AG Studio shows spend, pending approvals, blocked attempts and reasons.
9. **Red-team mode:** a button that replays the attack suite against the naive agent and the Mandate agent side by side.

**Stretch (only after the MVP is green):**
- **Adversarial seller agent:** a second agent that tries to trick the buyer agent (agent-to-agent commerce, and your test harness).
- **Bryntum Scheduler:** needed-by date vs delivery ETA.
- **KERNEL:** drives checkout on **a demo storefront you own** for merchants with no API. Never automate third-party sites without permission.
- **Astropods:** run the agent in a managed runtime with observability.

### A.3 Architecture

```
Teammate ─► Web UI (chat + dashboard)
                │
                ▼
        Agent service (Render web service)
   LLM planner ──proposes──► POLICY ENGINE (pure code, no LLM)
        │                        │  ALLOW / NEEDS_APPROVAL / DENY
        ▼                        ▼
  Channel3 search        PayPal Agent Toolkit / MCP (sandbox)
  (untrusted text)             │  orders · tracking · refunds · disputes
                               ▼
                    PayPal webhooks ─► Render Workflows (durable steps)
                               │
  Zapier MCP (approvals) ◄─────┤
  Elastic (audit index) ◄──────┴──► AG Studio dashboard
```

### A.4 Critical technical risk: can the agent really pay?
PayPal's Orders flow normally needs **payer approval** before capture (PayPal's own docs example captures "after approval by user"). Truly autonomous spending needs a pre-approved payment method. **Run this spike on Oct 23–24, before anything else:**

| Path | What | Status |
|---|---|---|
| 1 | Vaulted/saved payment method in sandbox so the agent captures within a pre-authorized mandate | **VERIFY** in PayPal Vault docs |
| 2 | Invoice-based flow: agent creates the invoice, the sandbox buyer pays | Works with documented tools |
| 3 | Approval link: below-threshold carts get a one-tap PayPal approval, above-threshold carts also go through your approver | Always works; still tells the guardrail story |
| 4 | KERNEL drives the **sandbox** buyer approval page with test accounts | **VERIFY**; stretch only |

If Path 1 fails, the story becomes "agent-prepared, mandate-checked, one-tap-approved" payments. That is still valid; the policy engine still gates what reaches the approval step. Don't spend more than two days on this spike.

Also: PayPal's remote MCP offers commerce tools (search, cart, checkout) that currently cover **gift cards only**. **VERIFY** whether they work in sandbox; if so, they are the one fully PayPal-native agent checkout you can show.

### A.5 PayPal and AI usage
- **PayPal:** `create_order`, `pay_order`, `get_order`, `create_refund`, `create_shipment_tracking` / `get_shipment_tracking`, `list_disputes` / `get_dispute`, `list_transaction`, `get_merchant_insights`; webhooks for state changes; JS SDK v6 for the approval UI.
- **AI:** intent parsing (structured output), shortlist ranking and explanation, plain-language policy explanations, and an injection-hardened prompt design that treats retailer text strictly as data.

### A.6 Sponsor map

| Sponsor | Real role | Depth | Prize angle |
|---|---|---|---|
| PayPal | Orders, tracking, refunds, disputes, webhooks | Core | Grand, PayPal + AI, **Agentic Commerce** |
| Channel3 | Product search and price data; untrusted-text source for the attack suite | Core | Channel3 prize (must call the API for real) |
| AG Grid (AG Studio) | Spend/approvals/blocked-attempts dashboard; custom widgets; a custom agent talking to Studio's agents ("explain this block") | Deep | AG Grid 1st–3rd (judged on polish **and** Agent Framework use) |
| Render | Hosting + Workflows for approvals, tracking polls, retries | Deep | Render 1st–3rd |
| APIMatic | Context Plugin while building the PayPal integration; document how | Light | APIMatic (3 winners) |
| Zapier | Approval requests and notifications over MCP | Medium | n/a (credits only) |
| Elastic | Audit-log index; "have we bought this before?" hybrid search | Medium | n/a |
| Postman | Collection + tests for your API, PayPal's collection while exploring | Light | n/a |
| Bryntum | Needed-by vs ETA timeline | Stretch | Bryntum (only if real) |
| KERNEL | Checkout on your own demo storefront | Stretch | n/a |
| Astropods | Managed agent runtime | Optional | n/a |

### A.7 Implementation plan
1. **Oct 22–24:** accounts, repo, payment-autonomy spike (A.4), one sandbox order created and captured by code.
2. **Oct 25–27:** deploy a thin vertical slice on Render (request → Channel3 → policy → PayPal → UI shows the transaction ID).
3. **Oct 28–Nov 2:** full policy engine with unit tests, approval flow (Zapier), tracking/refund, Elastic audit log, AG Studio dashboard v1.
4. **Nov 3–6:** attack suite + baseline comparison, red-team mode UI, dashboard polish (custom widgets, theming), README and results.
5. **Nov 7:** feature freeze.

### A.8 Evaluation
- **Benign set (about 30 requests):** task success rate, false-block rate (legitimate purchases wrongly denied), median latency, LLM cost per purchase.
- **Attack set (25+ cases, with a held-out half):** injection in title and description, price mismatch, currency swap, quantity inflation, replay/duplicate, over-cap splitting, fake "approved by admin" text.
- **Targets (set honestly and report whatever you get):** zero unauthorized captures on the attack set; false-block rate you can explain; the naive baseline visibly fails some attacks.
- Report failures, not just the wins.

### A.9 Judging-criteria mapping

| Criterion | How we earn it |
|---|---|
| Technological Implementation | Deterministic policy engine, durable workflows, idempotency, webhook handling, eval harness, real PayPal + Channel3 + Elastic + Zapier calls |
| Design | One coherent flow (set mandate → request → decision → pay → track), clear explanations of every block, polished dashboard |
| Potential Impact | Named user group, interview evidence, a quantified safety result |
| Innovation | Guardrail-first agent commerce, structuring and injection defenses, adversarial seller agent |
| Presentation | The side-by-side attack demo is the hook |

### A.10 Three-minute demo script
- **0:00–0:20** Problem: "Agents can spend money. What stops a poisoned product page from draining a budget?"
- **0:20–1:20** Happy path: set mandate, ask for supplies, see shortlist, small purchase auto-approved, sandbox transaction ID on screen.
- **1:20–2:20** Attack: same poisoned listing against the naive agent (pays) vs Mandate (blocked, with reasons). Show approval via Slack for a larger cart.
- **2:20–3:00** Dashboard, measured results, architecture, what's next.

### A.11 Risks

| Risk | Mitigation |
|---|---|
| Autonomous payment not possible | Spike on day 2; fallback paths in A.4 |
| "Another shopping agent" perception | Lead with the guardrail layer and the measured attack results, not shopping |
| Sandbox cannot pay real retailers | State plainly that fulfillment is simulated. Don't imply real settlement. |
| Over-scoped | MVP list is fixed; everything else is stretch |

---

## 4. IDEA B: **Runway** — a payment-aware project plan for freelancers

> *Your invoices, your schedule and your cash flow in one agent-run timeline. When a payment is late, the plan reacts.*

### B.1 User and problem
**Hypothesized user:** freelancers and 2–10 person agencies who bill clients in milestones, often across borders. **Validate that your interviewees actually use PayPal for invoicing; if they don't, pick a different audience.**

**Problem:** late payments silently break delivery schedules, chasing clients is awkward, cash flow is invisible until it hurts, and dispute evidence is scattered across contracts and chats.

### B.2 What we build

**MVP:**
1. **Contract intake:** paste or upload a contract/SOW text → AI extracts a structured plan (client, currency, deliverables, milestone amounts, due dates, payment terms). **Human confirms every amount and date before anything is created.**
2. **Invoice generation:** PayPal draft invoices per milestone (`create_invoice`), sent on schedule (`send_invoice`).
3. **Bryntum Gantt:** deliverables with **payment tranches as dependencies**. When a webhook reports a paid or overdue invoice, the agent **proposes** schedule changes (for example, "Phase 3 slides 5 days because tranche 2 is unpaid"); the user accepts or rejects.
4. **Collections agent:** tone ladder (friendly → firm → final) drafts reminders. Sends through `send_invoice_reminder` or Zapier email. A **code-enforced cadence policy** (max one reminder per week, no weekends, stop on dispute) governs sending.
5. **AG Studio dashboard:** receivables aging, expected cash by week, days-sales-outstanding, per-client reliability, plus natural-language questions ("who owes me more than 30 days?") via the Studio agent framework.
6. **Dispute pack:** when a dispute opens, the agent assembles evidence from the contract, messages and deliverable links (Elastic hybrid search) and drafts a response. **VERIFY** whether evidence submission is available through the sandbox API; if not, the human submits the pack.

**Stretch:** PayPal Subscriptions for retainer clients; multi-currency views; Zapier logging of paid invoices to a sheet.

### B.3 Architecture

```
Contract text ─► Extraction (LLM + schema validation) ─► Human confirm
                                                              │
                                                              ▼
                    PayPal draft invoices ◄──── Plan store (DB)
                           │                         │
                    PayPal webhooks ──► Render Workflows ──► Rescheduler agent
                           │                                        │
              Collections agent ──(policy: cadence)──► reminders    ▼
                           │                              Bryntum Gantt (proposals)
         Elastic (contracts, messages) ──► Dispute pack
                           │
                  AG Studio dashboard (aging, forecast, NL queries)
```

### B.4 Sponsor map

| Sponsor | Real role | Depth | Prize angle |
|---|---|---|---|
| PayPal | Invoicing, reminders, webhooks, disputes, optional Subscriptions | Core | Grand, PayPal + AI |
| Bryntum | Gantt where payments gate phases; agent-driven rescheduling | **Deep** | Bryntum (3 winners) |
| AG Grid (AG Studio) | Receivables dashboard, custom widgets, NL queries via Agent Framework | **Deep** | AG Grid 1st–3rd |
| Elastic | Search over contracts/messages; dispute evidence retrieval | Medium–Deep | n/a |
| Zapier | Email/Slack reminders, sheet logging | Medium | n/a |
| Render | Hosting + Workflows (webhook handling, nightly overdue sweep) | Medium | Render |
| APIMatic | Context Plugin for the PayPal Invoicing integration | Light | APIMatic |
| Postman | Test collection | Light | n/a |
| Channel3 | **No natural role. Don't force it.** | None | n/a |
| KERNEL | **No natural role.** | None | n/a |
| Astropods | Optional | Optional | n/a |

### B.5 Implementation plan
1. **Oct 22–24:** accounts, extraction prototype on 5 sample contracts, one sandbox invoice created, sent, and paid by a sandbox buyer.
2. **Oct 25–27:** deploy slice: contract → plan → invoices → paid webhook → plan updates.
3. **Oct 28–Nov 2:** Bryntum Gantt with dependencies and rescheduling proposals, collections agent with cadence policy, AG Studio dashboard v1.
4. **Nov 3–6:** Elastic dispute pack, evals, dashboard/Gantt polish, README and results.
5. **Nov 7:** freeze.

### B.6 Evaluation
- **Extraction:** 25 contracts you write (with a ground-truth sheet). Field-level precision/recall, and **exact-match required on amounts and dates** (a wrong amount is a critical failure). **Disclose that the contracts are synthetic.** Add 3–5 real, consented ones if you can.
- **Reminder policy:** a test suite of scenarios (weekend, existing dispute, already paid) with zero violations allowed.
- **Forecast:** compare against a simple baseline (per-client median days-to-pay). Evaluate on a time-based split to avoid leakage, and say the data is simulated.
- **Dispute pack:** recall@k of the right evidence on a seeded corpus.

### B.7 Judging-criteria mapping

| Criterion | How we earn it |
|---|---|
| Technological Implementation | Validated extraction, webhook-driven state machine, dependency-aware rescheduling, policy-enforced agent actions |
| Design | A single timeline that merges plan, payments and cash flow |
| Potential Impact | Interview evidence from real freelancers; quantified time/cash-flow benefit |
| Innovation | Payment events that change the project schedule; nothing in the standard invoicing tools does that, **but check this claim before you make it** |
| Presentation | "Client paid late; watch the plan react" is a clean 90-second story |

### B.8 Three-minute demo script
- **0:00–0:25** Problem, with a real freelancer's story.
- **0:25–1:15** Paste contract → confirmed plan → invoices created.
- **1:15–2:15** Simulate a late payment: webhook fires, Gantt proposes slips, collections agent drafts a friendly nudge, dashboard forecast shifts.
- **2:15–3:00** Dispute pack, metrics, what's next.

### B.9 Risks

| Risk | Mitigation |
|---|---|
| Invoicing agents are a crowded idea | The differentiator is the payment-aware plan; keep it front and center |
| Extraction errors involving money | Mandatory human confirmation; exact-match tests |
| Can't create sandbox disputes | **VERIFY** early; fall back to simulated dispute data and say so |
| Bryntum/AG trials expire during judging | Ask sponsors on Discord; video as primary evidence |

---

## 5. IDEA C: **ProofPay** — pay when the proof checks out

> *Conditional milestone payouts for community projects, NGOs and gig work. Donors see every dollar from donation to proof to payout.*

### C.1 User and problem
**Hypothesized users:** small NGOs, student and community drives, and platforms paying field workers or vendors; plus donors who want transparency. **Interview at least three organizers and three donors.**

**Problem:** donors can't see where money goes, organizers burn hours reconciling receipts, fraud (duplicate or inflated receipts) erodes trust, and vendors wait weeks to be paid.

### C.2 What we build

**MVP:**
1. **Campaign creator:** goal, milestones (budget, required evidence types, payee).
2. **Donations** through PayPal Checkout/Donate SDK in sandbox, tracked on a campaign ledger.
3. **Evidence upload** (receipt photo, work photo, vendor invoice) → AI extracts vendor, date, amount, line items and checks them against the milestone.
4. **Integrity checks (code + Elastic):**
   - duplicate and near-duplicate receipts (text similarity + image hash) across campaigns;
   - arithmetic consistency; date window; amount vs milestone budget; payee match;
   - **price reasonableness** for physical goods benchmarked via Channel3.
5. **Decision:** `AUTO_APPROVE` (all checks pass **and** amount under a code-enforced cap), `HUMAN_REVIEW`, or `REJECT`, always with reasons.
6. **Release** via **PayPal Payouts** to the payee. Payouts is a REST API, **not in the Agent Toolkit tool list**; you will call it directly. **VERIFY** sandbox Payouts access on day 1.
7. **Transparency page:** AG Studio ledger tracing donation → milestone → evidence → payout; Bryntum timeline of milestones.
8. **Notifications** via Zapier (reviewer queue, donor updates).

**Stretch:** recurring donor payouts to field partners; reviewer reliability stats.

### C.3 Honest limits you must state
- The build is **sandbox only**, and the platform is **not an escrow service**. In practice an organization would hold funds in its own PayPal business account. Holding and releasing other people's money has legal and licensing implications; say that a real deployment needs legal review.
- Receipt photos can contain faces, addresses and location metadata. Collect the minimum, strip EXIF location data, and get consent for any real images you use.

### C.4 Architecture

```
Donor ─► PayPal Checkout/Donate (sandbox) ─► Campaign ledger
Field worker ─► Evidence upload ─► Extraction (vision/LLM + schema validation)
                                         │
                      Integrity checks: Elastic similarity · arithmetic ·
                      date/amount/payee rules · Channel3 price benchmark
                                         │
                       Decision (code): AUTO_APPROVE / REVIEW / REJECT
                                         │
                    Reviewer queue (Zapier) ─► PayPal Payouts ─► Payee
                                         │
            AG Studio transparency ledger · Bryntum milestone timeline
            (Render Workflows run the evidence pipeline)
```

### C.5 Sponsor map

| Sponsor | Real role | Depth | Prize angle |
|---|---|---|---|
| PayPal | Donations, Payouts, webhooks | Core | Grand, Most Impactful, Most Creative |
| Elastic | Duplicate/near-duplicate receipt detection; evidence search | **Deep** | n/a |
| AG Grid (AG Studio) | Public transparency ledger with custom widgets | **Deep** | AG Grid 1st–3rd |
| Channel3 | Price benchmarks to flag overpriced receipts | Medium | Channel3 |
| Bryntum | Milestone timeline (Gantt or Calendar) | Medium | Bryntum |
| Render | Hosting + Workflows for the evidence pipeline | Medium | Render |
| Zapier | Reviewer and donor notifications | Medium | n/a |
| APIMatic | Context Plugin for PayPal integration | Light | APIMatic |
| Postman | Test collection | Light | n/a |
| KERNEL | **No natural role; skip.** | None | n/a |
| Astropods | Optional | Optional | n/a |

### C.6 Implementation plan
1. **Oct 22–24:** accounts, **Payouts sandbox spike**, one donation in and one payout out by code.
2. **Oct 25–27:** deploy slice: donate → evidence → extraction → decision → payout.
3. **Oct 28–Nov 2:** integrity checks (Elastic, rules, Channel3), reviewer queue, ledger dashboard v1.
4. **Nov 3–6:** labeled evidence suite + evals, timeline and ledger polish, README.
5. **Nov 7:** freeze.

### C.7 Evaluation
- **Labeled evidence set (about 60 items):** genuine, duplicate, altered amount, wrong vendor, out-of-window, screenshot-of-a-screenshot. **Synthetic evidence is optimistic; say so,** and add a small set of real, consented receipts from your own purchases.
- **Metrics:** precision and recall of fraud flags; **false-accept rate on fraudulent items** (the number that matters most; auto-approve only when every check passes); reviewer-minutes saved per item.
- **Baseline:** an LLM-only judge without the integrity checks. Show the gap.
- **Failure analysis:** which fraud types slip through, and why.

### C.8 Judging-criteria mapping

| Criterion | How we earn it |
|---|---|
| Technological Implementation | Multimodal extraction with validation, similarity search, rule engine, Payouts, workflows |
| Design | One traceable story from donation to payout, readable by non-experts |
| Potential Impact | Transparency and speed for orgs and vendors; interview evidence |
| Innovation | Proof-gated payouts with machine-checked evidence |
| Presentation | A donation traced to a payout in one screen |

### C.9 Three-minute demo script
- **0:00–0:25** Problem: "Where did my donation go?"
- **0:25–1:25** Donate → worker uploads receipt → checks pass → payout released.
- **1:25–2:15** Duplicate/inflated receipt gets caught, with reasons and a reviewer decision.
- **2:15–3:00** Transparency ledger, metrics, limits, what's next.

### C.10 Risks

| Risk | Mitigation |
|---|---|
| Payouts not available in sandbox | Day-1 spike; otherwise model payouts via orders/refunds and say so, or switch to Idea A or B |
| Vision extraction unreliable | Constrain evidence formats; confidence thresholds; human review as default |
| Legal overreach | Sandbox-only claim; document limits |
| Scope creep | Fixed MVP; drop the Bryntum timeline first |

---

## 6. Considered and not recommended

| Idea | Why not (as a primary) |
|---|---|
| Agent-to-agent price negotiation | High creativity, but weak real user and hard to evaluate; **use it as the adversarial seller agent inside Mandate instead** |
| Budgeting app that categorizes PayPal transactions | Commoditized; low technological depth |
| Creator tipping / membership page | Easy to build, low depth, crowded |
| A chatbot over PayPal APIs | Judges will read it as a thin wrapper around the toolkit |

---

## 7. Shared 21-day timeline

| Dates | Goal | Gate |
|---|---|---|
| **Oct 22–23** | Pick one idea; interviews booked; all accounts and credits claimed; repo created with LICENSE | Idea chosen by Oct 23 evening |
| **Oct 24–27** | Risky-assumption spike (payment autonomy / Payouts / sandbox disputes) and a **deployed thin slice** | **Gate 1 (Oct 27):** one real sandbox transaction executed by deployed code. If not, switch ideas or fall back. |
| **Oct 28–Nov 2** | Core features, safety/policy layer, first sponsor integrations, eval harness started | **Gate 2 (Nov 2):** end-to-end MVP flow works on the deployed app |
| **Nov 3–6** | Evals and failure analysis, dashboard/UX polish, error and empty states, README, tests | **Gate 3 (Nov 6):** README lets a stranger run it from scratch |
| **Nov 7** | **Feature freeze** | Bug fixes only after this |
| **Nov 7–9** | Record the video (do 2–3 takes), write the Devpost text, clean-machine test | |
| **Nov 10** | **Submit** | Draft saved earlier; the Representative submits |
| **Nov 11–12** | Buffer only. Remember the IST cutoff (evening of Nov 11). | |

**Roles for a 3–4 person team:** (1) PayPal + agent backend, (2) policy/evals/safety, (3) frontend + dashboard, (4) interviews + demo + docs. Everyone writes tests for their own part.

---

## 8. Submission checklist

- [ ] Public repo, **LICENSE visible in the About section**
- [ ] README: problem, user, architecture diagram, setup/run steps, tools used **and how**, metrics, known limits
- [ ] Hosted demo URL **and** local run instructions (do both)
- [ ] Test instructions and sandbox credentials for judges entered in the submission, not in the repo
- [ ] YouTube video, public, **under 3:00**, shows the real working app, no copyrighted music. Ask on Discord about showing PayPal's own checkout screens given the third-party trademark rule.
- [ ] Sponsor usage documented for every sponsor prize you're targeting (a `docs/sponsor-usage.md`)
- [ ] If any code pre-dates Oct 1: written explanation of what changed during the hackathon
- [ ] Team members all added in Devpost; Representative identified; prize-split agreed
- [ ] Clean-machine test on a fresh clone

**Devpost write-up template:** Problem and user · What it does · How we built it (per tool) · Results (your metrics) · Challenges and failures · Limits and ethics · What's next · Testing instructions.

---

## 9. Consolidated VERIFY list

1. Can the agent capture payments autonomously in sandbox (Vault/saved payment), or does it need payer approval? (Idea A)
2. Do PayPal's remote MCP commerce tools work in sandbox? (Idea A)
3. Is sandbox access to Payouts available, and with what permissions? (Idea C)
4. Can sandbox disputes be created, and can evidence be submitted via API? (Ideas B, C)
5. Exact webhook event names for invoice paid/overdue and order status changes (Ideas A, B)
6. How do AG Grid, Bryntum and Elastic handle trials expiring before Dec 15?
7. Whether the PayPal checkout screens count as third-party trademarks in the video
8. Whether your chosen audience actually uses PayPal (Idea B especially)
9. What similar products already exist, before you claim novelty in the README