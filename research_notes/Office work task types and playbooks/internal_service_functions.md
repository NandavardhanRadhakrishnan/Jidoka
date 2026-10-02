# Internal service-desk functions: task types, intake/triage, and playbooks (IT, HR, Legal, Procurement, Facilities; MNC to small firm)

Research date: 2026-10-02. Limit: about 19 tool calls. Several widely quoted statistics come only from vendor blogs or aggregators. Each one is flagged where it appears. Treat a number as solid only if it comes from a primary source (ServiceNow Community, CLOC, NAPEO, HDI, MetricNet).

---

## 1. IT service management (ITIL 4): categories, service catalogs, request models, standard changes, volumes, shift-left

### Takeaway
ITSM splits inbound work into **incidents** (unplanned break/fix), **service requests** (planned, catalogued, often pre-approved), and **changes** (standard/pre-authorized, normal, emergency). Repetitive, well-defined request types are formalised as "request models" or "standard changes" with a fixed procedure and no per-instance approval. Password resets have historically been about 30% of tickets. Automation and self-service claims for tier 1 are large but loosely sourced.

### Cited Findings
**Work-type taxonomy**
- ITIL distinguishes incidents from service requests. Incidents are unplanned work such as desktop/laptop break-fix, printer or server failure, and connectivity problems. Service requests are planned work such as moves/adds/changes, hardware refresh/replacement, and device upgrades. "Tickets" are the sum of both. — [HDI 2017 Technical Support Practices & Salary Report teaser](https://www.thinkhdi.com/~/media/HDICorp/Files/Industry-Reports/TSPSR/2017-tspsr-teaser-web.pdf) (2017, older than the preferred range)
- Standard service requests are "typical, routine, and well-defined requests" that service desk staff can address quickly. Examples: password resets, software installations, hardware requests. Pre-approved, low-risk requests get "an automated, streamlined process". — [Giva, ITIL Service Request Management Practice](https://www.givainc.com/resources/itil/service-request-management/) (vendor explainer)
- A **standard change** is "a low risk, preauthorized change which is relatively common and follows a known procedure". Standard changes are often handled through service request management. Examples given across sources: provisioning standard equipment to a new employee, adding a new user, password resets, lifecycle hardware replacement, software patching, firewall changes, new DNS entries, low-impact software updates. — [Faddom: Standard vs Normal vs Emergency](https://faddom.com/itil-change-management-types-standard-vs-normal-vs-emergency/); [ITSM Professor, Service Requests and Change Enablement (Aug 2025)](https://www.itsmprofessor.net/2025/08/service-requests-and-change-enablement.html?m=1); [Splunk on ITIL 4 change enablement](https://www.splunk.com/en_us/blog/learn/change-management.html)
- Because standard changes are pre-approved, they "can be implemented quickly following the established procedure without the need for further authorization". Normal changes need assessment/authorization (a change authority or CAB). Emergency changes use an expedited authority. — [Faddom](https://faddom.com/itil-change-management-types-standard-vs-normal-vs-emergency/); [ITILfromExperience on implementing standard changes](http://www.itilfromexperience.com/How+to+implement+Standard+Changes)

**Volume of specific types**
- HDI: "thirty percent of tickets are password-reset related", even though 69% of support teams let customers reset at least some passwords themselves. Where all passwords are self-resettable, about 34% of tickets are still password-related, versus 26% where they are not. HDI explains this counterintuitive figure as likely selection or reporting effects. — [HDI SupportWorld, Password-Reset Practices](https://www.thinkhdi.com/library/supportworld/2011/password-reset-practices) (**2011**, old but the original source of the widely repeated 30% figure)
- Vendor claims that "password resets account for 50% of help desk tickets" and cost about $70 per reset (attributed to HDI or Forrester) circulate widely, but they come from an identity-management vendor with a commercial interest. — [Avatier](https://www.avatier.com/blog/password-resets-for-help-desk-tickets/) (**vendor, treat as unverified**)

**Channels (how IT work arrives)**
- HDI: phone (93% of orgs) and email (88%) are the most common channels. Web forms are used by 54% of orgs and chat by 37%. Share of tickets: 48% phone, 35% email, 22% web form, 23% auto-logged (event monitoring). — [HDI 2016/2017 TSPSR teasers](https://www.thinkhdi.com/~/media/HDICorp/Files/Industry-Reports/TSPSR/2017-tspsr-teaser-web.pdf) (2016–17; the mix has likely shifted toward portal and chat since, and I found no free newer HDI breakdown)
- Tier-1 staff spend 73% of their time handling tickets. — same HDI teaser

**Effort and first-contact resolution**
- MetricNet: a service request takes **3–5x the work time of an incident** in every industry measured. Incidents average 12–22 minutes and service requests 35–96 minutes. — reported via [eesel.ai summary of MetricNet](https://www.eesel.ai/blog/help-desk-support) (secondary)
- MetricNet net first-level resolution: average 74.3%, median 74.9%, range 37.6%–97.8%. Only 1.4% of desks exceed 95%. Desktop-support incident FCR averages about 84% (range about 70–97%). — [MetricNet desktop support FCR](https://www.metricnet.com/desktop-support-metrics-part-5/); net-FLR figures via [eesel.ai](https://www.eesel.ai/blog/help-desk-support)

**Shift-left and automation**
- Figures attributed to Gartner: AI "deflects" more than 45% of queries, but only about 14% reach full self-service resolution (a gap of about 31 points). 40–70% of tier-1 volume is handled by automation. Self-service costs $1.84 per contact versus $13.50 for agent-assisted. "Up to 80% of Level 1 IT tickets autonomously resolved by agentic AI by 2030." — via aggregators [stealthagents](https://stealthagents.com/research/customer-support-ticket-volume-statistics-2026) and [eesel.ai](https://www.eesel.ai/blog/deflection-rate-what-is-it-and-how-to-improve-it) (**secondary; the underlying Gartner documents are paywalled and not verified. Several of these numbers are customer-service, not internal-IT, figures**)
- Gartner's 2025 Hype Cycle for ITSM (republished PDF) recommends virtual support agents to improve service desk efficiency. — [Gartner Hype Cycle for ITSM 2025, via Faddom](https://faddom.com/wp-content/uploads/2026/03/2025-Hype-Cycle-for-ITSM-Gartner-Report.pdf)

### Inferences
- The ITIL split maps directly onto Jidoka concepts. "Request model" or "standard change" ≈ a Jidoka **task type with an active rule**. "Normal change" ≈ a type whose rule ends in an approval/assign step. Incidents are less catalogue-friendly and need diagnosis, which suits an `agent` step plus human assignment.
- Pre-authorization in ITIL is granted to the *procedure*, not to each execution. This matches Jidoka's existing approval of write tools at rule activation (approve once per rule version, not per task).
- Service requests take 3–5x longer than incidents and are highly repeatable. That makes them the strongest case for AI pre-processing (gather the context, fill the form, then hand off).
- "Auto-logged" tickets from monitoring (23% in the HDI data) are a source type Jidoka would ingest through a task source, not email.

### Gaps
- No free, recent (2022+) HDI or SDI breakdown of ticket share by category (how-to, access, password, hardware). The 30% password figure dates from 2011.
- No primary Gartner source verified for deflection or auto-resolution rates.
- No published data on how accurate categorisation is (human or AI) in ITSM tools. Nothing found on misrouting or reassignment ("ping-pong") rates.
- I did not find an authoritative ITIL 4 sample category tree. Organisations build their own, typically with 2–3 levels such as Hardware > Laptop > Won't boot.

---

## 2. HR operations / HR service delivery (HRSD)

### Takeaway
Enterprise HR runs a **Tier 0–3** model: self-service, then HR generalists, then specialists, then HRBP/CoE/Legal. Cases are organised into a fixed category taxonomy (benefits, payroll, leave, verification, employee relations, lifecycle events), with SLAs per category and priority. Explicit **pause states** ("awaiting employee", "awaiting vendor", "awaiting effective date") are first-class. Onboarding and offboarding are modelled as **lifecycle events made of activity sets** that spawn tasks for IT, facilities, finance and the employee.

### Cited Findings
- Tier model: Tier 0 is self-service (knowledge articles, virtual agent, ESS for PTO balances, benefits review, pay-slip download). Tier 1 is the HR service center/generalists handling common inquiries that need a human. Tier 2 is specialists. Tier 3 is HRBP, CoE or Legal. — [ServiceNow Community: Best Practices SLA Configuration for HR Case Management (25 Jun 2026)](https://www.servicenow.com/community/hrsd-blog/best-practices-sla-configuration-for-hr-case-management/ba-p/3564624); [TechTarget: HR service delivery](https://www.techtarget.com/searchhrsoftware/definition/HR-service-delivery); [HR Exchange Network, multi-tier HRSD](https://www.hrexchangenetwork.com/hr-talent-management/articles/how-a-multi-tier-hr-service-delivery-model-transfo)
- HR case categories in that ServiceNow best-practice framework: General HR Inquiries, Benefits Administration, Payroll & Tax, Employee Relations, Leave Management & Accommodations, Compensation, Workforce Administration & Lifecycle Events, Talent/Performance/Learning. Other commonly cited top-level categories: Benefits, Payroll, Leave & Absence, **Employment Verification**, Workplace Relations, Onboarding, Offboarding. Each has subcategories and assignment rules. — [ServiceNow Community (2026)](https://www.servicenow.com/community/hrsd-blog/best-practices-sla-configuration-for-hr-case-management/ba-p/3564624)
- Case segmentation dimensions: category/subcategory, priority (driven by impact, regulatory risk and population affected), tier, and channel of origin (chat, portal, phone). — same source
- Representative SLA targets (BH = business hours, BD = business days):

  | Category | Response | Resolution |
  |---|---|---|
  | General HR inquiry (Tier 1) | 4 BH | 2 BD |
  | Benefits (P2) | 8 BH | 3 BD |
  | Payroll & Tax (P1) | 2 BH | 1 BD |
  | Leave/FMLA (P1) | 2 BH | 5 BD |
  | Employee Relations | milestone-based (intake, investigation start, findings) | |

  — same source
- Pause conditions, each with a maximum duration: "awaiting employee response" (max 5 BD), "awaiting third-party vendor" (max 10 BD), "awaiting effective date" (scheduled auto-reinstate), "awaiting manager/legal review" (max 3 BD). The SLA clock restarts automatically when the requester replies, on a scheduled date, or when the maximum duration expires (with a notification). — same source
- Escalation: alert at 25% of SLA elapsed, manager engaged at 50%, operational lead at 75%, executive at breach. *Functional* escalation overrides time thresholds for harassment, safety risk, executive requesters, or regulatory deadlines within 5 BD. The post says "most HRSD failures trace to over-assignment of P1" and recommends setting priority from decision tables, not agent discretion. — same source
- Onboarding is a **lifecycle event** made of **activity sets** (for example, pre-hire). Each lifecycle event (onboarding, role change, transfer, leave, offboarding) "touches multiple business applications and multiple departments". ServiceNow Enterprise Onboarding and Transitions assigns the tasks to IT, HR, facilities, finance, legal, or the new hire. — [ServiceNow Community: Lifecycle Event engine vs EOT](https://www.servicenow.com/community/hrsd-forum/hr-lifecycle-event-engine-vs-enterprise-onboarding-and/td-p/1337378); [ITChronicles on ServiceNow EOT](https://itchronicles.com/human-resources/servicenows-new-enterprise-onboarding-transitions-simplifies-complex-process/); [ServiceNow Success Playbook: Build an enterprise onboarding service (PDF)](https://www.servicenow.com/content/dam/servicenow-assets/public/en-us/doc-type/success/playbook/onboarding-service-enterprise.pdf); [Stonebranch: onboarding/offboarding workflow pattern](https://www.stonebranch.com/blog/employee-onboarding-and-offboarding-workflow-pattern-orchestrating-the-hire-to-retire-lifecycle)
- Offboarding coordinates ticketing, notifications, approvals, hardware returns and de-provisioning. The stated value is governance, security and auditability, while onboarding's value is employee experience. — [Inry: onboarding/offboarding with ServiceNow HRSD](https://www.inry.com/insights/strategies-for-streamlining-onboarding-and-offboarding-processes-with-servicenow-hrsd); [ReadyCloud: hardware asset returns](https://www.readycloud.com/info/simplifying-servicenow-hardware-asset-returns-complete-offboarding-refresh-guide)

### Inferences
- The HR category list is a ready-made seed for a Jidoka type registry: payroll query, benefits query, leave request/accommodation, employment verification letter, employee relations complaint, onboarding, offboarding, data change (address, bank details). Employee relations and harassment cases are the clearest "never AI-handled, escalate immediately" types. The ServiceNow functional-escalation rule is effectively a branch on content, not on time.
- **Pause/"waiting on requester" with auto-resume on reply** is standard in HRSD. Jidoka's board has no "waiting" state, and its task sources would need to recognise a reply as belonging to an existing task rather than as a new one.
- **Scheduled reinstatement** ("awaiting effective date") is a real need. It covers leave starting on date X and an offboarding on the last working day.
- Onboarding and offboarding are **parent/child** structures: one HR case spawning IT, facilities and payroll tasks with dependencies. Jidoka's `call_rule` runs synchronously. It does not create child tasks with separate assignees and lifecycles.

### Gaps
- No primary data found on the *share* of HR inquiries by type (for example, the percentage that are payroll vs benefits vs leave), or on the share resolved at each tier. Gartner did not surface it. The ScottMadden HR Shared Services benchmark PDF exists ([2023 highlights](https://www.scottmadden.com/content/uploads/2022/01/ScottMadden-2023-HRSS-Benchmark-Highlights-1.pdf)) but could not be text-extracted. APQC has a measure of calls/inquiries per HRSS FTE ([APQC](https://www.apqc.org/resources/benchmarking/open-standards-benchmarking/measures/number-callsinquiries-hr-shared-service)) but no free values.
- Workday Help's case-type taxonomy was not verified.
- No Deloitte Human Capital Trends or SHRM data retrieved within the tool-call budget.

---

## 3. Legal operations: front door, intake/triage, contract types, NDA self-service, review playbooks

### Takeaway
In-house legal teams increasingly run a "legal front door": a single intake form or email/Slack channel that triages by request type (NDA, commercial contract, employment, privacy, litigation, advice). The standard technique is **self-serve templated NDAs** plus **clause-by-clause playbooks** with preferred, fallback and walk-away positions, so non-lawyers or AI can close routine deals and escalate the rest. Demand is rising faster than headcount.

### Cited Findings
- CLOC 2026 State of the Industry (Harbor 2025 Law Department Survey; 135 departments, 15+ industries, median revenue $13B; released 2 Mar 2026): 63% report significant workload increases in regulatory compliance and 58% in cybersecurity. Only 32% expect attorney headcount increases. Expected inside-spend increases fell from 65% to 47%, and expected outside-counsel increases from 58% to 37%. 85% now have dedicated AI oversight or resources. Focus areas: technology strategy 80%, financial management 72%, outside counsel/vendor management 62%. — [CLOC press release](https://cloc.org/newsdesk/cloc-releases-2026-state-of-the-industry-report-rising-legal-demand-outpaces-budget-and-staffing-growth-forcing-operational-shift/) (the public summary has no intake/self-service statistics; the full report is members-only)
- Gartner: an estimated 20% of legal department time on unplanned work is wasted on rework and overanalysis. Gartner advises reducing legal touchpoints, keeping direct support for "bet-the-company" matters, and building guidance into high-volume "run-the-company" workflows. — [Gartner: Increase efficiency in unplanned legal work](https://www.gartner.com/en/legal-compliance/trends/increase-efficiency-unplanned-legal-work); [Smarter with Gartner: 6 shifts](https://www.gartner.com/smarterwithgartner/6-shifts-to-build-a-more-flexible-resilient-legal-department)
- Legal is involved in an average of 32% of contracts. Enterprises using automated routing and playbooks reduce that to 25%. — [Ironclad: legal approval bottlenecks, citing a "2026 Contracting Benchmark Report"](https://ironcladapp.com/resources/articles/legal-approval-bottlenecks) (**vendor source**)
- NDA self-service benchmarks: "80% of NDA volume can be handled through self-service". Configure automation so 60–70% of NDA volume is handled by the system. Auto-resolution targets for NDAs and intake are 60–80% "without legal touch" as playbooks mature. — [Checkbox](https://www.checkbox.ai/legal-intake/legal-intake-tool-self-service-workflows); [Pactly: automated triage for NDAs](https://www.pactly.com/blog/how-to-set-up-automated-triage-for-ndas); [Sandstone: first legal AI agent](https://sandstone.com/blog/your-first-legal-ai-agent-automate-nda-and-intake-triage-in-90-days) (**all vendor guidance; targets, not measured outcomes**)
- Playbook structure: for each clause, the playbook records a **preferred** position (ask first), a **fallback** (acceptable to keep the deal moving), and a **walk-away** (triggers senior sign-off or a hard no). Example entry for a SaaS liability cap: "Accept LoL at 12 months fees with super-cap at 3x for IP and data breach; negotiate up to 24 months above $250,000 ACV; hard reject below 12 months fees." Purpose: "a contract manager can close a routine deal without pinging the GC." — [GC AI: NDA review playbook](https://gc.ai/blog/nda-review-playbook); [Vaquill NDA playbook](https://www.vaquill.ai/playbooks/nda-playbook); [Vaquill in-house contract review playbook 2026](https://www.vaquill.ai/blog/in-house-contract-review-playbook); [fynk on contract playbooks](https://fynk.com/en/blog/contract-playbook/)
- Vendors also publish type-specific playbooks: NDA, DPA (data processing agreement) and SaaS vendor paper. — [Vaquill DPA playbook](https://www.vaquill.ai/playbooks/data-processing-agreement-playbook); [Vaquill SaaS agreement playbook](https://www.vaquill.ai/playbooks/saas-agreement-playbook)
- Legal front-door guidance: a single intake point (form, email or Slack) with triage by request type. Repeated questions are routed to self-service workflows. A solo GC's workflow still includes matter intake and triage. — [Checkbox: legal front door](https://www.checkbox.ai/blog/legal-intake-and-triage); [LawVu intake](https://lawvu.com/workspace/intake/); [Bind: legal triage system 2026](https://bindlegal.com/resources/guides/legal-triage-system-in-house/); [Vaquill: solo GC intake](https://www.vaquill.ai/blog/matter-intake-triage-workflow-solo-gc)

### Inferences
- Legal intake types that recur across sources: NDA (on our paper vs theirs), vendor/SaaS contract review, sales contract or redline, DPA/privacy review, employment matter, general legal question, litigation/claims, regulatory/compliance query.
- The preferred/fallback/walk-away playbook is *data consulted by an AI step*, not a control-flow branch. In Jidoka terms, it belongs in the `ai` step's prompt or a referenced document, and "walk-away hit" becomes a branch to human assignment. "Our paper, unmodified" vs "their paper" is a classic sub-case branch inside one type.
- The NDA percentages are aspirational vendor targets, so Jidoka should not assume them.

### Gaps
- No primary CLOC or Gartner figure found for the share of legal requests that are NDAs or contracts, or for adoption rates of formal intake tools. The relevant CLOC data is member-gated.
- World Commerce & Contracting data on contract volumes or cycle times was not retrieved.

---

## 4. Procurement: intake-to-procure, tail spend, approval workflows

### Takeaway
Procurement intake is consolidating around one front door ("intake-to-procure", for example Zip). A single request form with conditional questions routes each purchase or vendor request through rule-based, often **parallel** approvals (procurement, finance/budget, legal, IT, security/privacy), depending on amount, vendor risk and category. Tail spend (many small ad-hoc buys) is the high-volume, low-value segment.

### Cited Findings
- Gartner (as reported): by 2027, 50% of procurement organisations will use intake management. 70% of intake requests (purchase requisitions) will be AI/GenAI-assisted by 2027. 82% of orgs that implemented intake management say it met or exceeded expectations, and 50% fully realised ROI. 40% of sourcing activity will be done by non-procurement staff by 2027. 2025 Gartner Procurement Digital Transformation Survey: 93% name process efficiency as a top objective. — [procure.ai summary of Gartner](https://www.procure.ai/blog/ai-intake-management-will-assist-70-of-purchase-requisitions-by-2027); [Spendflo](https://www.spendflo.com/blog/intake-to-procure-software) (**secondary; Gartner originals paywalled**)
- Zip workflow: a single intake portal and standardised form with conditional logic per request type. Requests are routed by rules on purchase amount, vendor risk level and department policy. "Legal, finance, IT, and security reviews occurring in parallel". The same flow is used for virtual-card requests. Each request type gets "only the necessary approval steps". — [Brex: what is ZipHQ](https://www.brex.com/spend-trends/procurement/zip-procurement-software); [TrustRadius Zip reviews](https://www.trustradius.com/products/zip-intake-to-procure/reviews); [ERP Research Zip review 2026](https://www.erpresearch.com/erp-add-ons/procurement/zip-intake)
- Zip's own framing distinguishes "intake management" (front door) from "intake-to-procure" (front door plus approvals plus PO/ERP) and "procurement orchestration" (cross-system workflow). — [Zip newsletter](https://newsletters.ziphq.com/intake-to-procure-vs-intake-management-vs-procurement-orchestration-making-sense-of-an-evolving-landscape/)
- Tail spend is often characterised as about 80% of transactions but about 20% of spend. Hackett estimates around 7% (7.1%) savings from managing it. Over 50% of companies say tail spend exceeds 10% of total spend, but only 4% actively manage most of it. These purchases fall below approval thresholds and are spread across departments. — [Zycus on Hackett 2025](https://www.zycus.com/blog/spend-management/tail-spend-vs-tactical-spend-vs-maverick-spend); [Fairmarkit](https://www.fairmarkit.com/blog/what-is-tail-spend-and-how-can-we-manage-it); [Sievo](https://sievo.com/blog/what-is-tail-spend) (**the 80/20 is a rule of thumb, not a measured statistic**)

### Inferences
- Procurement request types: new purchase (catalogue item vs non-catalogue), new vendor/supplier onboarding (W-9 or tax forms, bank details, security questionnaire, DPA), software/SaaS purchase (triggers IT, security and legal review), renewal, RFQ/quote request, PO change, invoice/payment query (often AP), virtual card request.
- Procurement is the clearest **multi-department, parallel-approval** playbook. One request fans out into legal contract review (section 3), security review (IT), and budget approval (finance). In Jidoka this would need either several child tasks or an "awaiting approvals" state with N approvers. Neither exists today.
- Renewals are calendar-driven. They are **recurring/scheduled tasks** (for example, 90 days before contract end), not inbound items.

### Gaps
- No primary Hackett or Ardent Partners figure retrieved on requisition cycle times or the share of requests needing multi-party review.
- No data found on the share of procurement requests arriving by email vs portal.

---

## 5. Facilities / office admin

### Takeaway
I did not research facilities with dedicated searches within the budget. Only indirect evidence was gathered: facilities appears as a task recipient in onboarding/offboarding lifecycle events (desk/badge/access provisioning, asset return).

### Cited Findings
- Facilities is named as one of the departments receiving lifecycle-event tasks (with IT, finance and legal) in ServiceNow onboarding/offboarding orchestration. — [ITChronicles on ServiceNow EOT](https://itchronicles.com/human-resources/servicenows-new-enterprise-onboarding-transitions-simplifies-complex-process/); [ServiceNow Community](https://www.servicenow.com/community/hrsd-forum/hr-lifecycle-event-engine-vs-enterprise-onboarding-and/td-p/1337378)
- HDI classes "moves/adds/changes" as planned service-request work, a category shared with facilities in many organisations. — [HDI 2017 TSPSR teaser](https://www.thinkhdi.com/~/media/HDICorp/Files/Industry-Reports/TSPSR/2017-tspsr-teaser-web.pdf)

### Inferences
- Likely facilities types: maintenance/repair, room or desk booking, badge/access card, office moves, supplies, visitor management, mail/courier. These are inferred, **not sourced here**.

### Gaps
- No sourced data on facilities request taxonomies, volumes, SLAs, or IWMS/CAFM intake practices. This needs a follow-up search, for example IFMA, ServiceNow Workplace Service Delivery, or Planon/Archibus docs.

---

## 6. Small businesses (no IT department, owner does HR through a payroll provider or PEO, outside counsel)

### Takeaway
Small firms don't run service desks. They outsource whole functions: HR/payroll/benefits to PEOs or payroll providers, IT to MSPs, legal to outside counsel. The "service desk" is the owner's or an office manager's email inbox. Internal intake becomes forwarding requests to the right outside provider.

### Cited Findings
- NAPEO: 502 PEOs serve more than 233,000 mainly small and mid-sized businesses, with 5.4 million worksite employees. That is about 15% of US employers with 10–499 employees. — [NAPEO Industry Overview](https://napeo.org/intro-to-peos/industry-overview/)
- NAPEO-commissioned research: PEO clients grow more than twice as fast, have lower turnover, and are 50% less likely to go out of business. — [NAPEO press release](https://napeo.org/press-releases/new-economic-data-shows-peo-engagement-doubles-growth-rate-for-businesses/) (**industry-association research; self-interested**)
- PEO services typically include HR consulting, payroll, employer payroll tax filing, workers' comp, health benefits, compliance help, workforce tech and training, under a co-employment contract. — [Wikipedia: PEO](https://en.wikipedia.org/wiki/Professional_employer_organization); [FrankCrum](https://www.frankcrum.com/hr-outsourcing)
- A solo or small in-house GC still runs a matter intake and triage workflow, typically lightweight and email-based. — [Vaquill: solo GC intake](https://www.vaquill.ai/blog/matter-intake-triage-workflow-solo-gc)

### Inferences
- For small firms, the dominant "act" step in a playbook is **delegation to an outside party**: email the PEO, the MSP or outside counsel, then wait. "Awaiting third party" (which HRSD caps at 10 BD) matters even more here than in enterprises.
- A small firm's inbox mixes all functions (an IT issue, a vendor invoice, an employee leave request, an NDA from a prospect). Cross-function triage from a single email source, which is Jidoka's core model, fits small firms better than MNCs, where each function already has its own portal.

### Gaps
- No sourced statistic on the share of small businesses using an MSP for IT, or on how SMB owners split time across admin functions.
- No source found on how SMBs handle procurement approvals (likely owner approval of everything above a small threshold, but unsourced).

---

## 7. Cross-cutting patterns real playbooks need (approvals, waiting on requester, SLAs, parent/child, recurring)

### Takeaway
Across all four researched functions, real playbooks repeatedly need six things beyond "classify, then do steps, then assign":
1. Approvals: single, multi-party, parallel, and threshold-based.
2. Pause states with auto-resume ("awaiting requester/vendor/date").
3. SLAs per type and priority, with time-based escalation.
4. Content-based escalation overrides.
5. Parent/child task orchestration across departments.
6. Scheduled or recurring triggers.

### Cited Findings
- **Approvals**: ITIL pre-authorises standard changes per procedure, while normal changes need per-instance authorization. — [Faddom](https://faddom.com/itil-change-management-types-standard-vs-normal-vs-emergency/). Procurement routes approvals by amount, vendor risk and department, with legal/finance/IT/security in parallel. — [Brex on Zip](https://www.brex.com/spend-trends/procurement/zip-procurement-software). Legal playbook walk-away positions trigger senior sign-off. — [GC AI](https://gc.ai/blog/nda-review-playbook)
- **Waiting on requester or third party**: HRSD pause states with maximum durations (5 BD employee, 10 BD vendor, 3 BD manager/legal) and auto-resume on reply, date, or timeout. — [ServiceNow Community 2026](https://www.servicenow.com/community/hrsd-blog/best-practices-sla-configuration-for-hr-case-management/ba-p/3564624)
- **SLAs and escalation**: per category and priority, in business hours/days. Escalation at 25/50/75/100% of SLA. Priority set by a decision table, not by agent discretion. — same source
- **Content-based escalation**: harassment, safety, executive requester, or a regulatory deadline under 5 BD overrides time-based escalation. — same source
- **Parent/child, cross-department**: onboarding/offboarding lifecycle events produce activity sets with tasks for IT, facilities, finance, legal and the employee. — [ServiceNow EOT via ITChronicles](https://itchronicles.com/human-resources/servicenows-new-enterprise-onboarding-transitions-simplifies-complex-process/); [Stonebranch](https://www.stonebranch.com/blog/employee-onboarding-and-offboarding-workflow-pattern-orchestrating-the-hire-to-retire-lifecycle)
- **Scheduled triggers**: "awaiting effective date" with scheduled auto-reinstate. — [ServiceNow Community 2026](https://www.servicenow.com/community/hrsd-blog/best-practices-sla-configuration-for-hr-case-management/ba-p/3564624)
- **Tiered human escalation** is universal: IT tier 1/2/3 ([HDI](https://www.thinkhdi.com/~/media/HDICorp/Files/Industry-Reports/TSPSR/2017-tspsr-teaser-web.pdf)), HR Tier 0–3 ([ServiceNow Community](https://www.servicenow.com/community/hrsd-blog/best-practices-sla-configuration-for-hr-case-management/ba-p/3564624)), and legal "bet the company" vs "run the company" ([Gartner](https://www.gartner.com/en/legal-compliance/trends/increase-efficiency-unplanned-legal-work)).

### Inferences (alignment with Jidoka as described in CLAUDE.md)
- **Already aligned**:
  - AI triage into an evolving type registry ≈ the categorisation/service-catalogue step.
  - A per-type declarative rule built once and run per task ≈ request models, standard changes and contract playbooks. All are "procedure approved once, executed many times".
  - The `branch` step ≈ sub-cases (our paper vs theirs; P1 vs P2).
  - The `assign` step ≈ tier routing.
  - Approving write tools at rule activation ≈ ITIL standard-change pre-authorization.
  - "Pre-process before handoff" ≈ Tier 0/1 enrichment before a specialist picks the task up.
- **Likely gaps relative to real playbooks**:
  1. A **"waiting" state** (on requester, third party, approver, or date) with auto-resume when a reply arrives on the same thread. This requires the source to thread follow-up messages onto an existing task instead of ingesting new tasks.
  2. **Human approval steps** mid-rule (approve/reject, possibly several approvers in parallel, threshold-driven). Today `assign` hands off the whole task rather than pausing for a decision.
  3. **SLA/due-date and priority** fields, set by rule (decision table), with time-based escalation.
  4. **Parent/child tasks** (onboarding spawns IT, facilities and payroll tasks, each with its own assignee and state). `call_rule` is synchronous composition, not spawning.
  5. **Scheduled/recurring triggers** (contract renewals, effective-date actions, periodic checks), which do not arrive through any inbox.
  6. **Content-based hard escalation** (harassment, legal threats, safety) that should bypass AI handling regardless of rule. This could be a triage-level guardrail.
- The HRSD observation that "most failures trace to over-assignment of P1" suggests that priority, like type, is better derived by deterministic rules from extracted fields than by free AI judgement.

### Gaps
- No quantitative data found on what share of real tickets or cases enter a waiting state, or how many approval steps typical playbooks contain.
- No sources on how often parent/child decomposition is needed outside onboarding/offboarding and procurement.
