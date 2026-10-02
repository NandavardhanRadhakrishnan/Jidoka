# Customer service, customer success and sales ops: task types, triage, playbooks and AI/human split

Research date: 2026-10-02. Source-quality note: Many widely quoted CX numbers come through vendor blogs (Lorikeet, Macha, eesel, SentiSum, SupportBench, Unthread, Conexiom, Hyperfox, and others) that sell AI or automation. These are flagged **[vendor/aggregator]**. Primary sources (Gartner, Salesforce, McKinsey, Zendesk, Intercom docs, NBER) are preferred where they could be reached. Gartner and McKinsey pages returned 403 or timed out when fetched directly, so some of their numbers are quoted through secondary pages, and this is marked.

---

## 1. What do contact-reason taxonomies look like (categories, size, long tail, revision, failure modes)?

### Takeaway
Real taxonomies are usually 2-level (topic → subtopic). Practitioners recommend about 30-50 leaf tags, but organisations often drift to 100-500. Volume follows a strong Pareto curve: about 20 of about 100 categories carry about 80% of volume, and one or two reasons (for example "where is my order" in ecommerce, or login/billing in banking) can be 20-50% on their own. The main failure mode is human tagging: agents pick a tag in about 3-10 seconds, and catch-all "General/Other" tags get overused. The usual fix is to keep the taxonomy small, write a definition for each tag, audit it weekly or regularly, and use ML/LLM discovery to find new topics.

### Cited Findings
- **Size and structure:** SentiSum recommends a two-tier system (Tier 1 topic such as `product_issue`, Tier 2 subtopic such as `shipping_delay`) and an optimal range of 30-50 tags. Some clients started with 400-500 categories, which "became unwieldy." Example leaf names: `Damaged_package`, `Size_small`, `Refund_requested`, `Payment_failed_paypal`. Naming principle: primary topic first, then specifics. — [SentiSum, help desk ticket categories](https://www.sentisum.com/customer-service-analytics/help-desk-ticket-categories-best-practices) [vendor]
- **Agent tagging speed:** agents categorise manually in about 3 seconds, so large taxonomies are impractical. General tags such as "packaging" "become a catch-all for any kind of issue, so agents apply them quickly and move on." — [SentiSum](https://www.sentisum.com/customer-service-analytics/help-desk-ticket-categories-best-practices) [vendor]
- With 400-500 tags, agents pick the first "good enough" tag. Generic "General"/"Miscellaneous" categories are overused as defaults under time pressure, which undermines dashboards. Recommendation: 30-50 tags plus weekly blind audits of 50-100 tickets. — [SupportBench, auto-tagging best practices](https://www.supportbench.com/automate-tag-suggestions-avoid-wrong-data/); [Unthread tagging statistics](https://unthread.io/blog/support-ticket-tagging-statistics/) [vendor/aggregator]
- **Manual tagging accuracy:** reported at 60-70%, against 89-96% for AI tagging. About 30% of tickets in traditional systems need reassignment, and misrouting costs $22+ per ticket. — [Unthread](https://unthread.io/blog/support-ticket-tagging-statistics/) [vendor/aggregator. The methodology behind these numbers is unclear, so treat them as indicative only.]
- **Pareto:** "80% of customer ticket volume comes from 20 ticket categories... among about 100 categories, 20 represents 80%." — [Cleverly AI on Medium](https://medium.com/@cleverlyai/the-pareto-rule-in-customer-service-why-20-topics-are-taking-80-of-your-effort-eaf26255768a) [vendor blog]. MetricNet also teaches an 80/20 module for contact centres — [MetricNet](https://www.metricnet.com/contact-center-metrics-essentials-module-2-the-80-20-rule/)
- **Top 10 concentration (complaint/repeat calls):** the top 10 repeat-call reasons account for 67% of all repeat calls among complaint callers. — [SQM Group](https://www.sqmgroup.com/resources/library/blog/customer-complaint-calls)
- **Banking examples:** one benchmark gives billing questions 16%, information/product inquiries 12%, account management 10%, and payments 5%. Another gives login issues 29%, payment/transfer 19%, address/personal info updates 18%, and balance/recent transactions 17%. — [MeasuringU, Why do people call customer service](https://measuringu.com/customer-service/) (via search summary)
- **Ecommerce:** WISMO ("where is my order") is quoted at 20-40% of tickets and up to 50% of calls, rising to 50%+ at peak (Black Friday). WISMR ("where is my return") is quoted at 10-20%, peaking in January. Each WISMO contact costs $5-22 with a human agent. — [ClickPost](https://www.clickpost.ai/en-us/blog/what-is-a-wismo-complaint), [Claimlane](https://www.claimlane.com/resources/blog/reduce-where-is-my-order-queries), [Shopify blog](https://www.shopify.com/blog/wismo-ecommerce) [vendor; the ranges vary widely between sources]
- 86% of US online shoppers met at least one delivery issue in the past year, and 74% had a late delivery (Narvar, Nov 2025, n=3,461). — via [Macha source index](https://www.getmacha.com/blog/customer-service-ai-statistics)
- **"Dumb contacts" / root cause:** Bill Price's *The Best Service is No Service* (Amazon's former VP of customer service) frames contacts as breakdowns elsewhere in the business. Customer service is not the root cause of 80-90% of contacts, and Price suggests 80% as a self-service target. — [CustomerThink](https://customerthink.com/the-best-service-is-no-service-turns-10-going-strong/), [Informa Connect](https://informaconnect.com/best-service-is-no-service-bill-price/)
- **Revision:** categories should be "iterated regularly as new issues emerge," and ML can surface previously unseen topics. — [SentiSum](https://www.sentisum.com/customer-service-analytics/help-desk-ticket-categories-best-practices). Macro-style audit cadence: retire anything unused in 90 days. — [Swifteq / eesel via search](https://swifteq.com/post/zendesk-macros-best-practices)
- **Vendor intent taxonomies:** Zendesk intelligent triage classifies every ticket by intent (topic), sentiment (5 levels, Very Positive to Very Negative), and language (about 150 languages), and extracts entities (for example product names). Each field carries a confidence value, admins can create custom intents, and agents can override values. The outputs feed "triggers, automations, macros, SLAs, queues, and the ticket API." — [Zendesk help, intelligent triage](https://support.zendesk.com/hc/en-us/articles/4550640560538-Automatically-classifying-tickets-with-intelligent-triage)

### Inferences
- **Synthesised catalog of recurring inbound task types**, combining the sources above with standard practice (illustrative, not from a single source):
  - **Order lifecycle (B2C/B2B):** order status/WISMO; delivery problem (late, lost, damaged); order change (address, quantity, item); cancellation; return/RMA request; where is my return/refund; exchange.
  - **Billing/payments:** invoice question or copy; payment failed; refund request; dispute/chargeback; pricing question; subscription change, downgrade or cancel.
  - **Account/access:** login/password; update personal details; account closure; data/privacy (GDPR) request.
  - **Product/technical:** how-to; bug or defect report; feature request; outage/incident.
  - **Pre-sales:** product question; quote request; availability/stock/lead time; partnership or reseller inquiry.
  - **Relationship:** complaint/escalation; compliment/feedback; legal/regulatory letter; VIP/executive request.
  - **Noise:** spam, auto-replies, out-of-office replies, misdirected mail.
- For Jidoka, this supports "types come from real tasks": a small type registry (tens, not hundreds) with descriptions and examples matches practice. Expect a few types to dominate, so onboarding effort on the top 5-10 types covers most volume.
- The "Other" bucket problem maps directly onto Jidoka's "propose a new type / ask when ambiguous" design. Jidoka should track the size of any catch-all type as a health signal and surface clusters inside it as new-type candidates.

### Gaps
- No rigorous, independent measurement was found of "Other" bucket size (for example "% of tickets tagged Other"). Only qualitative statements exist.
- No primary study was found of how often enterprises formally revise taxonomies (quarterly or annually); the advice is generic.
- COPC and HDI contact-reason standards were not reachable or found in open sources.
- The Activeo "Best Service is Still No Service" white paper (2024) was found, but it was image-based and could not be parsed.

---

## 2. How is triage done in practice (agents, rules, ML/LLM), how accurate, and how is ambiguity handled?

### Takeaway
Triage has three layers that coexist: (1) deterministic rules and triggers (channel, form field, keyword, customer tier → group or queue); (2) ML/LLM intent classification with confidence scores; (3) human agents fixing the label. Ambiguity is handled almost everywhere with a confidence threshold: below it, the ticket goes to a default or manual-review queue, or a human picks the label. Reported intent accuracy is about 87-91% on the common intents, mostly from vendor sources.

### Cited Findings
- **Zendesk intelligent triage accuracy:** reported at 87% after one week and 91% after three weeks for the 15 most common intents. Queue/agent assignment is correct 80%+ of the time. — [Swifteq guide](https://swifteq.com/post/zendesk-intelligent-triage) / [eesel](https://www.eesel.ai/blog/zendesk-ai-agent-intent-confidence-threshold) [secondary/vendor]
- **Confidence handling:** Zendesk's legacy confidence threshold runs 0-100 with a default of 60. Below it, the configured fallback applies. Practitioners commonly use 70-80 and send low-confidence tickets to a default group for manual review. Confidence is exposed as High/Medium/Low so admins can route differently, flag low-confidence tickets, and exclude them from reports. Account eligibility requires at least 30% of tickets labelled with high confidence and at least 60% with medium confidence. — [eesel](https://www.eesel.ai/blog/zendesk-ai-agent-intent-confidence-threshold), [Swifteq](https://swifteq.com/post/zendesk-intelligent-triage) [secondary]
- Zendesk publishes an Explore recipe comparing intelligent-triage intent predictions with a custom, agent-set "About" field. In other words, the vendor expects customers to validate AI labels against human labels. — [Zendesk Explore recipe](https://support.zendesk.com/hc/en-us/articles/5429030095258-Explore-recipe-Comparing-intelligent-triage-intent-predictions-with-a-custom-About-field)
- **Escalation triggers in AI-first triage (Intercom Fin):** by default Fin escalates when the customer asks for a human, shows strong frustration or anger, or is stuck in a loop. There are two configuration mechanisms. *Escalation Guidance* is natural-language scenarios (for example frustration words, or repeated visits to pricing or cancellation pages). *Escalation Rules* are structured data attributes. When a rule matches, "Fin does not generate an answer... but hands the conversation off." — [Intercom help, escalation guidance and rules](https://www.intercom.com/help/en/articles/12396892-manage-fin-ai-agent-s-escalation-guidance-and-rules)
- **Customer patience with bots:** 84% will give a virtual agent three attempts or fewer (Genesys State of CX, Jul 2026, n=5,811). 87% say an option to reach a human is essential when GenAI is used (Gartner, Aug 2026, n=3,566). — via [Macha source index](https://www.getmacha.com/blog/customer-service-ai-statistics)
- **Shared-inbox triage at small scale:** with 2-5 people, the main failure is two people replying to the same email. Assignment plus collision detection is reported to cut first response time by about 40%. — [InboxPilot / GridInbox, via search](https://www.inboxpilot.co/blog/shared-inbox-vs-help-desk) [vendor]

### Inferences
- Jidoka's design (an AI classifier against a registry, asking the human when ambiguous, user choice saved as an example) matches industry practice: confidence threshold → manual review → label correction. Industry rarely feeds corrections back as few-shot examples explicitly; Jidoka doing so is a differentiator.
- Real systems combine deterministic pre-routing (sender domain, VIP list, form field) with AI classification. Jidoka triage could take cheap signals from a source (for example "came from billing@ alias") as hints.
- Accuracy is high on the common head intents and weak on the long tail. Expect ambiguity questions to cluster on rare or new types.

### Gaps
- No independent (non-vendor) benchmark of LLM intent classification accuracy on real support tickets was found.
- No primary data was found on misrouting or reassignment rates beyond the vendor "30% need reassignment" figure.

---

## 3. What do playbooks, macros and SOPs look like, who writes them, and how are they versioned?

### Takeaway
There are three generations. First, **macros** (canned reply plus field actions: set status, group, tag) and **triggers/automations** (event-condition-action rules) in Zendesk, Freshdesk and Salesforce. Second, **knowledge articles** governed by KCS. Third, **AI-agent procedures** (Intercom Fin Procedures, 2025-26): natural-language SOPs pasted from Google Docs or Notion, then structured into steps with deterministic conditions, data-connector calls, human approval gates, versions, and simulation tests. Support ops or CX ops staff own them. The most common failure is stale, unowned macros.

### Cited Findings
- **Zendesk macros:** up to 5,000 shared macros per account. There is no native macro usage report, so teams add a tracking tag per macro and retire anything unused in 90 days. Macros combine actions (status, group, tag) with the reply. Name them for search (for example "[Support] Close - Not reproducible"). "Every shared macro should have a named owner... the most common failure mode is a stale shared macro nobody owns." For triggers: clone before modifying and deactivate the original so you can revert, which serves as poor-man's versioning. — [eesel Zendesk automation guide](https://www.eesel.ai/blog/zendesk-automation-guide), [Swifteq macros best practices](https://swifteq.com/post/zendesk-macros-best-practices), [Macha](https://www.getmacha.com/blog/how-to-use-zendesk-macros-best-practices) [secondary/vendor]
- Treat macros as governed operating assets: run periodic review packets showing which macros are stale, which conflict with current policy, and which need owner approval before reactivation. — [Fabren](https://www.fabrenhq.com/blog/ai-support-macro-review-workflow) [vendor]
- **KCS (Knowledge-Centered Service, Consortium for Service Innovation, since 1992; v6):** knowledge is captured "at the point of creation, in the context of demand." Individuals own their actions and the collective owns the knowledge base. Article metadata covers Visibility, Quality/confidence state, and Governance (who can edit). Article states regulate workflow. — [Consortium for Service Innovation, KCS v6](https://library.serviceinnovation.org/KCS/KCS_v6/KCS_v6_Practices_Guide/041), [Article state technique](https://library.serviceinnovation.org/KCS/KCS_v6/KCS_v6_Practices_Guide/030/040/010/030), [Wikipedia](https://en.wikipedia.org/wiki/Knowledge-centered_support)
- **Intercom Fin Procedures (2025-26):** these handle "complex queries with multiple steps, business logic, third party systems, or cross-team approvals." They combine natural-language instructions with deterministic controls (if/else, code-evaluated conditions, data-connector calls). Teams "copy and paste your existing SOPs straight in (most support teams already have them written up in Google Docs or Notion)," and Fin structures them into a procedure. Simulations run full fake conversations before launch. — [Intercom, building Fin Procedures](https://www.intercom.com/help/en/articles/13449439-building-fin-procedures), [fin.ai procedures guide](https://fin.ai/learn/fin-procedures-guide)
- Procedures support code conditions, data connectors, human-in-the-loop approvals for critical actions, and "manage procedure versions and publishing" (drafts, previews, controlled rollouts). Typical uses are refunds, cancellations, order modifications, and account management. — [Intercom, Fin Procedures explained](https://www.intercom.com/help/en/articles/12495167-fin-procedures-explained)
- Fin Tasks were superseded by Procedures, and a migration guide exists. — [Intercom, transitioning from Tasks to Procedures](https://www.intercom.com/help/en/articles/13459670-transitioning-from-fin-tasks-to-procedures)

### Inferences
- **Typical playbook shapes (synthesised):**
  - **Refund:** verify the order and eligibility window → check amount against an auto-approve threshold → auto-refund under the threshold, otherwise route to a human for approval → send a confirmation macro.
  - **Complaint/escalation:** detect negative sentiment or an escalation keyword → raise priority → gather order and history context → assign to a senior/tier-2 or complaints team → set an SLA timer.
  - **VIP:** customer-tier attribute (from CRM) → bypass AI → named account owner or priority queue.
  - **Legal/regulatory or chargeback:** always route to a human (compliance), as in Klarna's lessons below.
- Intercom's Procedures model is strikingly close to Jidoka's rule model: an NL description, then structured steps with branches, tool calls, approval gates, versions, and pre-activation tests. This is strong external validation. Jidoka's "agent builds the rule from an NL description" also matches "paste SOP → structured procedure." Differences worth noting are that Fin adds *simulations* (test conversations) before publishing and puts human approvals *inside* procedures as steps.
- Jidoka should expect users to have SOPs in Docs or Notion already. Importing an existing SOP as the handling description is a natural onboarding path.

### Gaps
- No primary data was found on who formally authors playbooks across company sizes (support ops vs team leads vs QA). Only vendor statements exist.
- Salesforce Service Cloud (Omni-Channel skills-based routing, case assignment rules, Flows) and Freshdesk/Front rules were not researched in depth because of the tool-call budget.
- No hard numbers were found on macro counts per team or macro usage rates.

---

## 4. What do analysts and vendors say about AI resolution, human-in-the-loop, agent assist, and where AI fails?

### Takeaway
There is a large gap between vendor and analyst numbers. **Customer-reported full self-service resolution is low (Gartner: 14%, 2024; Ada/NewtonX: 24% fully resolved by AI, 2026).** Practitioner estimates are about 30% of cases handled by AI (Salesforce 2025-26) and a Zendesk enterprise median deflection of about 41%. Vendor-dashboard resolution rates are higher (Intercom Fin about 76% average; Ada 52% resolution vs 72% containment on the same conversations). Agent assist (summaries, suggested answers, next-best-action) is the most mature use case and has peer-reviewed productivity gains of about 14-15%. AI fails on complex, emotional, regulated (disputes, account closure) and action-requiring cases (Klarna's 2025 walk-back). Customers insist on a human option.

### Cited Findings
**Resolution and deflection**
- Gartner (Aug 2024, n=5,728 customers): only 14% of service issues are fully resolved in self-service. — via [Macha](https://www.getmacha.com/blog/customer-service-ai-statistics), [CX Today](https://www.cxtoday.com/contact-center/agentic-ai-gartner-predicts-80-of-customer-problems-solved-without-human-help-by-2029/)
- Gartner prediction (Mar 2025): agentic AI will autonomously resolve 80% of *common* customer service issues by 2029, with 30% lower operational costs. This is a forecast, not a measurement. — [CX Today](https://www.cxtoday.com/contact-center/agentic-ai-gartner-predicts-80-of-customer-problems-solved-without-human-help-by-2029/)
- Salesforce State of Service (7th edition, 2025): service teams estimate 30% of cases are handled by AI today and expect 50% by 2027. Companies expect AI agents to cut cost and resolution time by about 20%. — [Salesforce news](https://www.salesforce.com/news/stories/state-of-service-report-announcement-2025/), [Salesforce blog](https://www.salesforce.com/blog/state-of-service/). The 2026 edition (n=3,075) reports AI agent adoption rising from 39% to 66% (2025 → 2026) and 85% of service orgs using at least one form of AI — via [Macha](https://www.getmacha.com/blog/customer-service-ai-statistics)
- Ada/NewtonX (Mar 2026, n=2,000 consumers): only 24% say their most recent AI service interaction was fully resolved by AI alone. — via [Macha](https://www.getmacha.com/blog/customer-service-ai-statistics)
- Vendor benchmarks: Intercom Fin averages 76% across about 12,000 customers ("improving ~1%/month," top performers 80-84%). Ada shows 52% resolution vs 72% containment across 550+ deployments, a 20-point gap on identical conversations from the definition alone. Gorgias has a 45% median on AI-touched tickets. Typical maturity curve: 40-60% at launch, 60-76% at 6-12 months, mid-80s best-in-class on transactional queues. — [Lorikeet 2026 benchmarks](https://www.lorikeetcx.ai/articles/resolution-rate-ai-customer-support-benchmarks-2026), [Macha](https://www.getmacha.com/blog/customer-service-ai-statistics) [vendor/aggregator]
- Metric definitions, strictest to loosest: verified resolution (no escalation or repeat contact within 24-48h), automated resolution, containment (ended without handoff), and deflection (shown an article). "A 70% resolution rate that includes 30 points of article views is really 40%." — [Lorikeet](https://www.lorikeetcx.ai/articles/resolution-rate-ai-customer-support-benchmarks-2026) [vendor]
- Zendesk: enterprise median deflection of 41.2% (top quartile 58.7%). AI-handled tickets get CSAT 4.10/5 vs 4.30/5 for humans. — [Zendesk CX Trends 2026, via search summary](https://cxtrends.zendesk.com/gb) [not verified on the primary page]
- Freshworks Customer Service Benchmark 2025 (32,000+ companies, 1.2B tickets): AI agents deflect 45%+ of queries, and retail on Freddy AI reaches 53% resolved without humans. Median first response time is about 1 hour, falling to minutes for AI-enabled leaders. — [Freshworks](https://www.freshworks.com/How-AI-is-unlocking-ROI-in-customer-service/), [Macha](https://www.getmacha.com/blog/customer-service-ai-statistics)
- Klarna (Feb 2024): its AI assistant handled 2.3M chats (two-thirds of chats) in month 1, with about $40M of savings claimed and a 25% drop in repeat inquiries. In May 2025 it reversed course and resumed hiring humans after generic answers and failures on complex or nuanced cases. Problems cited include hallucinations on edge cases, lower CSAT on emotional tickets, and compliance concerns about AI handling disputes and account closures. The CEO said they "focused too much on efficiency and cost… the result was lower quality." — [FinTech Weekly](https://www.fintechweekly.com/magazine/articles/klarna-hires-customer-service-after-ai-pivot), [Lorikeet](https://www.lorikeetcx.ai/articles/resolution-rate-ai-customer-support-benchmarks-2026) [secondary press]

**Agent assist / pre-processing for humans**
- NBER/QJE (Brynjolfsson, Li, Raymond), 5,179 agents: an AI assistant raised issues resolved per hour by about 14-15% on average, with the largest gains for novice and low-skilled agents. — [NBER w31161](https://www.nber.org/papers/w31161); McKinsey cites the same study as +14% resolutions per hour and −9% handle time — [McKinsey, via search](https://www.mckinsey.com/capabilities/operations/our-insights/where-is-customer-care-in-2024)
- McKinsey: 30-40% of claim-related call time is silence while agents search for information, which agent assist removes. A telecom case saw call volume fall about 30% and AHT fall more than 25%. 57% of care leaders expect call volumes to *rise* in the next 1-2 years. 71% of Gen Z and 94% of baby boomers see live calls as the quickest way to get help. Gen AI could cut human-serviced contacts by up to 50%. — [McKinsey, contact center crossroads](https://www.mckinsey.com/capabilities/operations/our-insights/the-contact-center-crossroads-finding-the-right-mix-of-humans-and-ai) (via search summaries; the direct fetch timed out)
- Gartner (Oct 2025) groups the most valuable AI use cases into four areas: assisted agents (summaries, quick answers, real-time customer insight, next-best action), customer self-service, automated operational support, and agentic AI. Auto-summarisation and auto-replies are described as maturing. — [Gartner press release, 2025-10-08](https://www.gartner.com/en/newsroom/press-releases/2025-10-08-gartner-says-the-most-valuable-ai-use-cases-for-customer-service-and-support-fall-into-four-areas) (403 on fetch; content via [CXM](https://cxm.world/customer-experience/gartner-highlights-the-most-valuable-ai-use-cases-for-customer-service/))

**Pressure, ROI, staffing and trust**
- Gartner: 77% of service leaders feel executive pressure to deploy AI (n=265, Apr-May 2025), rising to 91% (n=321, Oct 2025). Only 20% have reduced staffing due to AI, and 55% hold staffing stable while volumes rise. Only 24% show positive financial returns across AI use cases (Jul 2026). — [CX Today](https://www.cxtoday.com/contact-center/77-of-customer-support-leaders-feel-pressure-from-execs-to-deploy-ai-finds-gartner/), [Macha](https://www.getmacha.com/blog/customer-service-ai-statistics)
- Gartner (Jul 2024): 64% of customers would prefer companies didn't use AI in service. Gartner (2026): customers are about 3x more likely to use third-party GenAI (ChatGPT and similar) than company chatbots, 51% of service journeys start on third-party platforms, and only 27% would retry a chatbot after a bad experience. — [Gartner 2026-07-08 press release](https://www.gartner.com/en/newsroom/press-releases/2026-07-08-gartner-survey-finds-customers-are-three-times-more-likely-to-use-third-party-genai-than-company-provided-chatbots-for-customer-service), [Macha](https://www.getmacha.com/blog/customer-service-ai-statistics)
- Deloitte Digital (Jun 2026, n=720): average cost per assisted contact is $7.80, up from $6.70 in 2024. — via [Macha](https://www.getmacha.com/blog/customer-service-ai-statistics)
- Intercom (Jan 2026, n=2,470): only 10% of teams report mature AI deployment. — via [Macha](https://www.getmacha.com/blog/customer-service-ai-statistics)

### Inferences
- A defensible planning number for Jidoka-type users is that about 25-45% of inbound customer-service volume is realistically AI-resolvable today, mostly head intents (status, how-to, simple policy). The rest needs a human. Pre-processing for that human (summary, context, suggested reply) is the most proven value, and is exactly Jidoka's "pre-process before handoff" step.
- Rule steps should hard-route regulated or emotional categories (disputes, chargebacks, legal, account closure, strong negative sentiment, VIP) to humans. Klarna's walk-back and Fin's default escalation conditions both point this way.
- Jidoka should measure outcomes with strict definitions (for example "reopened or follow-up within 48h") to avoid inflated "AI handled" counts.

### Gaps
- The primary Gartner, McKinsey, Forrester and Accenture pages could not be fetched (403 or timeout). Several figures are second-hand.
- No Forrester, BCG or Accenture CX numbers specific to this scope were retrieved. COPC and HDI benchmarks were not found openly.

---

## 5. How do small businesses handle the same work?

### Takeaway
Small teams run support out of email (Gmail/Outlook shared mailbox or a shared-inbox tool). The owner or a few generalists answer, with no formal taxonomy and with saved replies or templates as the "macros." Practitioners suggest moving to a helpdesk at about 10+ tickets/day or 2+ people sharing a mailbox. Evidence here is thin and mostly vendor-sourced.

### Cited Findings
- 68% of teams with under 15 agents still use email as their primary channel (Support Driven survey 2025, as cited). — [GridInbox](https://gridinbox.com/blog-shared-inbox-small-business) [vendor, secondary citation]
- Rule of thumb: switch from email to a helpdesk at around 10+ tickets/day or two agents sharing a mailbox. In 2-5-person teams the main failure is duplicate replies. Assignment plus collision detection is reported to cut FRT by about 40% (example: 4.5h → 2.1h). — [InboxPilot](https://www.inboxpilot.co/blog/shared-inbox-vs-help-desk), [GridInbox](https://gridinbox.com/blog-shared-inbox-small-business) [vendor]
- Salesforce publishes a growing-business cut of State of Service, which suggests SMBs are adopting AI later than enterprises. — [Salesforce small-business blog](https://www.salesforce.com/blog/small-business/state-of-service-report-insights-for-growing-businesses/)
- Freshworks: the median software company replies in about 47 min, the fastest fifth in about 2 min, and the slowest tier in about 6h. — [Unthread / Ringly summarising Freshworks](https://www.ringly.io/blog/customer-service-response-time-benchmarks) [aggregator]

### Inferences
- For SMBs the "task types" are the same as for enterprises, but they live implicitly in the owner's head and inbox folders or labels. Jidoka's type discovery from real tasks fits better than up-front taxonomy configuration. SMBs also mix customer-service, sales and admin email in one inbox, so triage must separate support, sales, vendor/supplier and noise.

### Gaps
- No rigorous (non-vendor) survey of SMB customer service practice (who answers, tools, volumes) was found.

---

## 6. Sales ops: recurring tasks (lead routing, quotes, PO/order entry, CRM hygiene) and their playbooks

### Takeaway
The recurring email-driven sales-ops work is order entry from emailed POs (PDF/Excel), quote requests (RFQ), order changes and cancellations, returns/RMAs, inbound lead routing and follow-up, and CRM data hygiene (dedup, enrichment, decay). Order entry consumes 20-40% (up to 60% at peak) of inside-sales/CS time. Lead response is notoriously slow. CRM data decays at about 22.5%/yr. Most of these numbers come from automation vendors.

### Cited Findings
- **Order entry:** CS and inside-sales reps spend 20-40% of their time on manual order handling. A mid-market specialist spends about 40% of the day on it, rising to 60%+ at peak. In wholesale, 90-95% of inbound POs arrive by email as PDFs, Excel files, or even photographed or faxed handwriting. Manual processing takes 8-30 minutes per order (IOFM/APQC benchmarks as cited). — [Conexiom](https://conexiom.com/blog/the-real-cost-of-manual-order-entry-in-b2b-operations), [Hyperfox](https://www.hyperfox.com/insights/the-real-cost-of-manual-order-entry), [Bizowie](https://bizowie.com/how-distributors-can-automate-80-of-manual-order-entry) [vendor]
- **Lead response:** an HBR audit of 2,241 US firms found an average first response of 42 hours to web leads. Only 37% responded within 1 hour, and 23% never responded (2011). The MIT/InsideSales (2007) study found contacting within 5 rather than 30 minutes raised contact odds about 100x. Lead-routing tools are reported to cut response time to about 3.5h from about 13h. — [Kixie](https://www.kixie.com/sales-blog/speed-to-lead-response-time-statistics-that-drive-conversions/), [DigitalApplied 2026](https://www.digitalapplied.com/blog/speed-to-lead-response-time-benchmarks-2026-data-playbook), [AI Integrated Solutions critique](https://aiintegratedsols.com/insights/speed-to-lead-statistics) [aggregators. The original studies are old (2007/2011), and the latter source warns these stats are widely misquoted. The claim that "63.5% of 1,000 B2B SaaS never responded (2024)" is unverified.]
- **CRM hygiene:** B2B data decays at about 22.5%/yr (about 2.1%/month). The average company carries 10-30% duplicate records, against a <5% benchmark. Reps lose an estimated 27% of hours (about 546h/yr) to bad data. Validity's 2025 report says 37% of teams lose revenue from poor data quality, and its 2024 report says 48% of admins saw decay accelerate. — [Validity blog](https://www.validity.com/blog/data-quality-management/), [Validity State of CRM Data Mgmt 2022 PDF](https://www.validity.com/wp-content/uploads/2021/04/State-of-CRM-Data-Management-2022.pdf), [this+that compilation](https://www.thisandthat.chat/blog/crm-data-decay-statistics/) [mixed primary/aggregator; the 27% and 22.5% figures are second-hand]
- **Quotes/RFQs and order changes:** B2B platforms bundle "order and quote management" (quote request → sales review → quote → convert to order). — [B2BWave](https://www.b2bwave.com/order-and-quote-management) [vendor]

### Inferences
- **Synthesised sales-ops playbooks:**
  - **PO email → extract lines** (customer, SKU, qty, price, ship-to, requested date) → validate against ERP (price list, stock, credit hold) → create a draft sales order → a human reviews exceptions → send confirmation.
  - **RFQ** → extract the items → check pricing tier and availability → draft a quote → a rep approves (discount thresholds need manager approval) → send and log in CRM.
  - **Order change/cancel** → locate the order → check whether it has shipped or been invoiced → apply the change or route to a human.
  - **RMA** → verify the order and warranty or return window → issue an RMA number and label → notify the warehouse.
  - **Inbound lead** → enrich → dedupe against CRM → score → route by territory, segment or round-robin → SLA timer.
  - **CRM hygiene** → periodic dedupe/merge, bounce cleanup, and enrichment.
- These match Jidoka's step catalogue (AI extract/summarise → MCP read from ERP/CRM → branch → assign) well. The write actions (create order, send quote) are exactly where Jidoka's write-tool approval gate matters. CRM hygiene is a *scheduled/batch* job rather than inbound-item-driven, so it fits Jidoka's ingest-a-task model less naturally.

### Gaps
- No independent (non-vendor) measurement of order-entry time share or PO channel mix was found. All figures come from automation vendors.
- No data was found on quote-request volumes or cycle times, or on RMA handling time.
- Customer success task types (renewal risk, QBR prep, onboarding check-ins, health-score alerts) were not researched within the tool budget.
