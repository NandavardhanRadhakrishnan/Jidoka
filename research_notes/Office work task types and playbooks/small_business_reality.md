# Small and micro business admin work: workload, channels, playbooks, tools and AI adoption (research notes, Oct 2026)

Scope: businesses with roughly 1–50 employees (many sources use <100, <250 or ≤200, flagged where relevant). Sources date from 2021 to 2026. The source type is marked throughout: **[Gov/IGO]** = government or intergovernmental, **[Assoc]** = business association, **[Vendor]** = a survey commissioned by a software or finance vendor (usually opt-in, with a commercial interest in the result), **[Blog/agg]** = a secondary aggregator, so treat it with caution. A few figures came only from search-result snippets I did not open; those are marked "(snippet only)".

---

## 1. How many hours a week do owners spend on admin, and on which tasks?

### Takeaway
Surveys agree on roughly **8–20 hours a week** of admin and finance work for the owner. That is 20–36% of a 50-hour week. Most of it goes to bookkeeping, invoicing and payment chasing, tax and regulatory compliance, payroll and HR, and email or scheduling. Late payment is the best-measured single pain point. Payment chasing is a recurring, rules-based task that consumes a lot of time.

### Cited Findings
**Overall admin hours**
- A 2025 Time Etc survey reports that small business owners spend about **16 hours a week** on admin tasks such as emails, bookkeeping and scheduling. [Vendor; VA company; snippet only] — [The Industry Leaders](https://www.theindustryleaders.org/post/the-two-day-problem-how-business-owners-lose-16-hours-a-week-to-work-that-should-not-be-theirs); [heyteo aggregator](https://heyteo.ai/resources/small-business-admin-statistics)
- UK SME Business Barometer: 1,000 owners of UK micro, small and medium businesses estimated an average of **11 hours a week on admin or finance tasks**. The same coverage says owners spend "twice as much time on admin as on growing the business". [snippet only; the barometer's sponsor was not verified] — [Asian Trader](https://www.asiantrader.biz/small-business-owners-admin-burden)
- Australia: the average SME owner spends **8–12 hours a week** on finance and admin. [Blog/agg; snippet only] — [ScaleSuite](https://www.scalesuite.com.au/resources/where-sme-owners-spend-their-time)
- Xero, citing a Forbes survey: the average entrepreneur spends **about 36% of the working week** on admin, about 18 hours of a 50-hour week. Xero says "most estimates" put it at **15–20 hours a week**, with **bookkeeping and financial management alone at 5–10 hours a week**. [Vendor, secondary] — [Xero "time tax" guide](https://www.xero.com/us/guides/time-tax-small-business/)
- An American Action Forum estimate puts small business regulatory paperwork at **379 hours a year**, about 10 working weeks. About **50%** of owners say they spend too much time and money on regulatory requirements (US Chamber, as cited by Xero). — [Xero](https://www.xero.com/us/guides/time-tax-small-business/)
- Most business owners (**63%**) work more than 50 hours a week, but want to work about 41.7. [snippet only] — [Agility PR](https://www.agilitypr.com/pr-news/pr-news-trends/time-management-new-survey-reveals-biz-owners-spending-time-theyd-rather-spend/)
- Startup founders, pre-revenue to Series A, spend **36–40%** of their hours on admin (Kauffman / Hinge Research High Growth Study 2024). This is not the core SMB segment and comes via an aggregator. — [Stealth Agents](https://stealthagents.com/research/startup-admin-burden-statistics-2026)
- **NFIB [Assoc]:** "government regulations and red tape" has been among small owners' **top-three problems every month since January 2009**. In a separate poll, 49% called regulation a very serious (25%) or somewhat serious (24%) problem. NFIB stresses that the owner *is* the compliance officer. — [NFIB testimony (Harned)](https://oversight.house.gov/wp-content/uploads/2018/03/Harned_NFIB-Testimony_03142018.pdf) (2018 testimony, so older than the preferred window)

**Late payments and chasing (the best-measured admin task)**
- **UK, DBT and Office of the Small Business Commissioner, research by London Economics, published 31 July 2025 [Gov]:** **28%** of businesses (over 1.5m) suffer late payment each year. **22%** spend staff time chasing it, on average **86 hours a year per affected business** and **133 million hours** across the economy. Late payment costs about **£11bn** a year, about **£26bn** is outstanding at any moment, the average amount owed is **£17,000**, about **14,000 businesses close each year (38 a day)**, and **15%** have refused work from customers because of their payment history. — [Small Business Commissioner](https://www.smallbusinesscommissioner.gov.uk/late-payments-research-2/)
- The FSB [Assoc] puts the time cost of chasing debt for UK small firms at **£1.6bn a year**. — [Business Times](https://business-times.co.uk/articles/business/government-unveils-crackdown-on-late-payments-as-fsb-hails-landmark-win-for-small-firms/); [GOV.UK crackdown announcement](https://www.gov.uk/government/news/time-to-pay-up-toughest-crackdown-on-late-payments-in-a-generation-unveiled-in-plan-to-back-small-businesses)
- **Xero Small Business Insights, Q2 2026:** small businesses waited **29.3 days** on average to be paid, with payments almost **9 days late** on average. [Vendor; based on real ledger data, not a survey; snippet only] — [Xero](https://www.xero.com/us/guides/late-payment-small-business/)
- Chaser 2022 late payments report: **53.4%** of businesses spend **4+ hours a week** on accounts receivable, and over a quarter spend up to an hour a week only on chasing late payments. [Vendor; snippet only] — [Chaser 2022](https://www.chaserhq.com/the-2022-late-payments-report)

**Task categories that recur across sources** (synthesised from the sources above and the AI-use sections below): bookkeeping and expense categorisation; invoicing and payment reminders; quotes and estimates; customer enquiries and customer service; scheduling, appointments and staff rosters; payroll and HR; tax and regulatory filings; marketing and social media. Salesforce lists "building a sales quote", "scheduling employees" and "sending invoice payment reminders" as its canonical SMB automation examples. — [Salesforce SMB Trends recap](https://www.salesforce.com/blog/small-business/ai-and-the-future-of-business/)

### Inferences
- A sensible planning figure is about 10–16 hours a week of owner admin. The higher figures (16–20) come from vendors selling admin relief, so treat them as an upper bound.
- Payment chasing has an unusually clean shape for Jidoka's model. It is triggered by data (an overdue invoice) rather than by an inbound message, it follows a standard playbook (polite reminder, then firm reminder, then call or stop work), and the rule is easy to state in natural language. However, the trigger lives in the accounting ledger (Xero, QuickBooks), not the inbox, so a ledger-based task source or MCP read access matters as much as email.
- Compliance and tax work is periodic and deadline-driven (calendar-triggered), not message-triggered. Much of it happens through an accountant, so it fits an inbox-triage model less well.

### Gaps
- I found no large, methodologically transparent survey (government or academic) that splits SMB admin hours *by task category*. Task-level splits are vendor estimates.
- I could not open the primary documents for the Time Etc, UK SME Barometer and Forbes 36% figures.
- India and emerging markets: I found no hours-on-admin data.

---

## 2. Which channels do customer and supplier requests arrive through? Email versus WhatsApp, SMS and phone by region

### Takeaway
In the US and UK, **email and phone dominate**, with SMS and texting growing. Phone is the leakiest channel: a majority of calls go unanswered in vendor studies. In **India**, **WhatsApp is near-universal** among small retailers and as common as email among more formal, digitised MSMEs. An email-only ingestion model would miss a large share of real work, especially for trades, restaurants, retail and anything in India or other emerging markets.

### Cited Findings
**US/UK**
- About **53%** of businesses handle most support interactions by email, **48%** by voice, **38%** by live chat and **38%** by text. [Blog/agg; the original survey is unclear] — [this+that](https://www.thisandthat.chat/blog/small-business-communication-statistics)
- 411 Locals 2024 study: only **37.8%** of calls to small businesses were answered by a live person, 37.8% went to voicemail and **24.3% got no response**. Separately, "62% of inbound calls are missed on first attempt". [Vendor studies, via aggregators] — [Oncrew](https://oncrew.ai/resources/missed-call-statistics); [getaira](https://www.getaira.io/blog/missed-business-calls-statistics)
- A 2025 survey of 1,000 US consumers found only **42%** leave a voicemail, and **78%** say they have abandoned a business after an unanswered call. [Vendor; via aggregator] — [this+that](https://www.thisandthat.chat/blog/small-business-communication-statistics)
- **US Chamber 2025 [Assoc]:** generative AI (44%) is now the second most-used technology platform among small businesses, behind search engines (46%) and ahead of social media (42%). This shows how central web search and social are to the small business stack. — [IPWatchdog summary of US Chamber report](https://ipwatchdog.com/2025/08/18/us-chamber-report-small-businesses-rapidly-adopting-ai-despite-regulatory-concerns/)

**India**
- **India SME Forum, "State of Digitalisation in Indian MSMEs" (2025; 7,835 MSMEs surveyed 2024–25; 59.1% micro firms with 1–9 employees; convenience or voluntary sample, so it skews digitally aware) [Assoc, Meta-associated report card]:** 53.8% (4,218) had integrated digital or e-commerce into core operations. The channels used for day-to-day interaction with suppliers, partners and customers were **Email 3,979; WhatsApp 3,323; website forms, chat or portals 2,758; mobile phone calls 2,331; SMS 1,115** (counts of respondents). The report says email is used by **95.4% of digitised firms** and calls it "the default channel for customer interaction, order confirmation, and supplier coordination". CRM use was 71.8% and e-commerce platform use 70.4%. — [India SME Forum PDF](https://indiasmeforum.org/digishaastra/assets/docs/Final-META-Report-Card-2025.pdf)
- **PayNearby MSME Digital Index 2024 (10,000+ retail MSMEs: kirana stores, medical shops, mobile recharge outlets, travel agents and similar) [Vendor; fintech]:** WhatsApp or WhatsApp Business use was **97%**. Among "tech-savvy" MSMEs, only **29%** used accounting software, 17% POS software and 14% CRM. 43% preferred UPI for last-mile banking. — [Entrepreneur India](https://india.entrepreneur.com/news-and-trends/whatsapp-and-whatsapp-business-dominate-msme-landscape-with/476232); [BW Businessworld](https://www.businessworld.in/article/msmes-witness-68-growth-in-business-post-digital-tech-adoption-repor-524575)
- About 78–80% of India's small businesses use WhatsApp for customer communication. These figures trace to Meta-commissioned research and are relayed by WhatsApp-API vendor blogs. [Vendor/agg] — [Gallabox](https://gallabox.com/blog/whatsapp-business-statistics); [Inc42](https://inc42.com/features/how-whatsapp-business-is-bringing-indias-smes-to-the-digital-fold/)
- **The two Indian surveys disagree.** The formal, digitised MSMEs in the India SME Forum survey report email as the top channel, while the small retailers in PayNearby's survey are almost entirely on WhatsApp, with little accounting software or CRM. The difference is mainly sampling: digitally aware owners of registered firms versus neighbourhood shops.

### Inferences
- **Email-first fits** professional services (accountants, agencies, consultancies, B2B suppliers) and formal B2B MSMEs in India. **Email-only does not fit** trades, restaurants, salons, clinics or kirana-type retail. Their work arrives by phone, SMS and WhatsApp, and phone requests often leave no written record at all.
- A WhatsApp Business task source would be the single highest-value addition for India and emerging markets. Phone needs voicemail or call-log transcription to become a task at all.
- Supplier coordination (orders, confirmations) shows up in the same channels as customer requests. Triage therefore has to separate "customer enquiry" from "supplier order confirmation" inside one WhatsApp or email stream. That matches the type-registry approach.

### Gaps
- I found no rigorous, regionally comparable survey of channel *share of inbound work* for micro-businesses (as opposed to channels *used*).
- The UK and EU have no WhatsApp-for-business figures here. Anecdotally WhatsApp is strong in the EU, LatAm and the UK trades, but I found no source.
- Social DMs (Instagram, Facebook) and marketplace messages (Etsy, Amazon, Google Business Profile) as inbound work channels are not quantified.

---

## 3. How common are written SOPs or playbooks? How do owners delegate? Which tools do they use?

### Takeaway
Rigorous data on SOP prevalence in micro-businesses **essentially does not exist**. The widely repeated claims ("80% can't run without the owner", "70–80% keep SOPs in scattered docs") come from consultants and SOP-software marketing. The consistent qualitative picture is that process knowledge is tacit and lives with the owner. The tool stack is Google Workspace or Microsoft 365, plus accounting software, spreadsheets and messaging apps. Tool setup and selection is itself a top barrier, which is significant for a product that asks users to write rules.

### Cited Findings
- About **80%** of small businesses "cannot operate independently of their owner", and buyers discount owner-dependent businesses by 20–50%. About **70–80%** keep their SOPs in scattered Google Docs, Notion pages, email threads or binders, and **83%** "need better SOPs but can't justify enterprise pricing". [Blog/agg, SOP and consulting vendors; no methodology; treat as illustrative] — [Forbes Business Council, Sep 2026](https://www.forbes.com/councils/forbesbusinesscouncil/2026/09/28/the-hidden-asset-that-can-increase-the-value-of-your-business/); [MicroGaps](https://www.microgaps.com/gaps/2026-02-24-sop-process-documentation-small-teams); [Stratisian](https://stratisian.com/blog/sop-blueprint-process-driven-business)
- **India SME Forum 2025:** the single biggest ongoing challenge is finding and setting up digital tools. **36.8%** find "navigating and setting up digital tools" somewhat or very challenging (11.1% "very"), and **35.6%** struggle with "finding the right digital tools". Only **5.3–8.0%** rate finding customers, entering markets, hiring or getting finance as challenging. The executive summary gives **52.6%** for the tool-finding difficulty, which is inconsistent with the 35.6% in the body text. **97.3%** were unaware of any government digitalisation schemes. — [India SME Forum PDF](https://indiasmeforum.org/digishaastra/assets/docs/Final-META-Report-Card-2025.pdf)
- The same report describes CRM penetration as a sign that customer relationships are moving to structured platforms "rather than spreadsheets or memory". This implicitly acknowledges that spreadsheets and memory are the baseline. — [India SME Forum PDF](https://indiasmeforum.org/digishaastra/assets/docs/Final-META-Report-Card-2025.pdf)
- **Goldman Sachs 10,000 Small Businesses Voices [Assoc/philanthropic; Goldman]:** **44%** of owners say they lack the resources and expertise to deploy AI successfully, and only **14%** say AI is fully embedded in core operations (2025 survey). — [Fox Business summary](https://www.foxbusiness.com/economy/small-business-ai-adoption-jumps-68-owners-plan-significant-workforce-growth-2025); [Capsule CRM aggregator](https://capsulecrm.com/blog/small-business-ai-adoption-statistics/)
- Capterra 2026 Software Buying Trends (fielded Aug 2025; 3,385 respondents in 11 countries including India; "small" = 5–249 employees): **56%** had adopted accounting or finance software in the past 12 months. [Vendor; snippet only] — [Capterra](https://www.capterra.com/resources/tech-trends-business-software-buying/)
- Tool stack (qualitative, from consultants): Google Workspace or Microsoft 365 is the foundation, with spreadsheets as the "source of truth" for leads, orders and budgets. One consultant claims about **60%** of small-business Zapier/Make use is wiring Microsoft or Google products to each other. [Blog; illustrative only] — [Zapier guide](https://zapier.com/resources/guides/automation-for-small-businesses/spreadsheets-and-databases); [McCary Group](https://mccarygroup.com/consolidate-small-business-tech-stack/); [J Mares](https://www.jmares.com/post/part-3-the-software-you-re-already-paying-for-automation-hiding-inside-microsoft-365-and-google-wo)
- A vendor (Time Etc, a virtual-assistant company) frames delegation to VAs as the answer to the 16 hours a week of admin. — [The Industry Leaders](https://www.theindustryleaders.org/post/the-two-day-problem-how-business-owners-lose-16-hours-a-week-to-work-that-should-not-be-theirs)

### Inferences
- **This is a strong fit for Jidoka's "describe the handling in natural language" onboarding.** Owners rarely have written SOPs, but they can usually *say* how they handle something ("if it's a quote request for under X, send the price list; otherwise call them"). Turning a spoken or typed description into an executable rule spares them the documentation step they never do. The rule also becomes the documented SOP as a side effect, which addresses the "owner dependency" problem.
- **The risk is setup friction.** Indian MSMEs rank tool setup as their biggest hurdle, and 44% of US owners lack expertise to deploy AI. Bring-your-own-AI (API keys, provider choice) and MCP-server configuration are exactly the setup steps this segment struggles with. Pre-built task sources, default MCP servers and templated starter types ("invoice chase", "quote request", "booking request") would probably be needed.
- Delegation in micro-firms usually means handing a task to one specific person (a family member, an office manager, a VA, the external accountant). The "assign to human" outcome needs to name a person, not just say "a human".

### Gaps
- **I found no rigorous source (government, academic or association) on what share of micro or small businesses have written SOPs.** All figures found are marketing claims.
- I found no reliable quantitative data on how many small businesses use VAs or outsourced admin, or on Zapier, Make, Trello, Notion or HubSpot penetration in businesses with 1–50 employees.
- I found no data on how much of the work goes to an external bookkeeper or accountant (likely large for compliance and tax).

---

## 4. SMB AI adoption rates (2024–2026), what they use AI for, and barriers

### Takeaway
Adoption depends heavily on the definition. Vendor and association surveys report that **58–76%** of US small businesses "use AI", mostly chat tools, but the **US Census BTOS finds only about 9%** using AI to produce goods or services (Aug 2025). The tasks most often cited are **marketing, customer service and admin**, with bookkeeping close behind. Depth is shallow: only 13–14% call AI core or fully embedded. Barriers are skills and expertise, data privacy and legal concerns, and "not suited to our work". Cost is mentioned less often than expected.

### Cited Findings
**Adoption rates**
- **US Chamber "Empowering Small Business" 2025 [Assoc; Teneo; 3,870 US small businesses under 250 employees; fielded 6–26 June 2025]:** **58%** use generative AI, up from **40% in 2024** and more than double 2023. The Chamber calls this the fastest uptake it has tracked since social media. State range runs from 31% (West Virginia) to 77% (Maine). **82%** of AI-using firms increased headcount. **65%** worry that a patchwork of state AI laws will raise compliance costs. — [US Chamber](https://www.uschamber.com/technology/empowering-small-business-the-impact-of-technology-on-u-s-small-business); [report PDF](https://www.uschamber.com/assets/documents/Empowering-Small-Business-Report-2025.pdf); [IPWatchdog](https://ipwatchdog.com/2025/08/18/us-chamber-report-small-businesses-rapidly-adopting-ai-despite-regulatory-concerns/)
- **Intuit QuickBooks Small Business Insights, April 2025 [Vendor; 2,200+ US businesses with up to 100 employees]:** **68%** use AI regularly (up from 48% in July 2024), **28%** daily, and **13%** call it a "core component". **74%** say it boosts productivity and **24%** say work days are shorter, while **11%** report *longer* workdays. About **1 in 10** owners are early adopters of agentic AI. — [QuickBooks April 2025 survey](https://quickbooks.intuit.com/r/small-business-data/april-2025-survey/); [QuickBooks agentic AI article](https://quickbooks.intuit.com/r/running-a-business/agentic-ai-for-business/)
- **Goldman Sachs 10,000 Small Businesses Voices:** **68%** used AI and another 9% planned to within a year (2025 survey). A March 2026 release reports **76%** currently using AI, with **93%** of users reporting positive impact and **84%** citing efficiency. **87%** say AI augments rather than replaces staff. Owners named AI a top resource "particularly for automating administrative tasks and improving customer communication". Only **14%** have it fully embedded, and **44%** lack resources or expertise. — [Goldman Sachs 2026 press release](https://www.goldmansachs.com/pressroom/press-releases/2026/small-businesses-embrace-ai-but-need-training-and-support-to-fully-harness-it) (403 when fetched; figures from the search summary); [BusinessWire](https://www.businesswire.com/news/home/20260317141697/en/Survey-Small-Businesses-Embrace-AI-But-Need-Training-and-Support-to-Fully-Harness-It); [Fox Business](https://www.foxbusiness.com/economy/small-business-ai-adoption-jumps-68-owners-plan-significant-workforce-growth-2025)
- **Salesforce SMB Trends, 6th edition [Vendor; 3,350 leaders of firms with ≤200 employees in North America, LatAm, APAC and Europe]:** **75%** at least experimenting with AI, **34%** "fully integrated", and **71%** plan to increase AI investment. **91%** of SMBs using AI say it boosts revenue. — [Salesforce news](https://www.salesforce.com/news/stories/smbs-ai-trends-2025/); [Salesforce report page](https://www.salesforce.com/resources/research-reports/smb-trends/?bc=OTH)
- **Contradiction: US Census Bureau BTOS [Gov]:** **8.8%** of small businesses (under 250 employees) used AI in producing goods or services as of August 2025, up from 6.3% six months earlier. The broader "any business function" measure for all firms was about **17.3%**. Small-firm adoption was accelerating while large-firm adoption plateaued, and **firms with 1–4 employees had the second-highest AI use rate** of any size class. — [SBA Office of Advocacy Research Spotlight, Sep 2025](https://advocacy.sba.gov/wp-content/uploads/2025/09/Research-Spotlight-AI-in-Business-Small-Firms-Closing-In_-092425.pdf) (403 when fetched; figures from search summary); [Census blog](https://census.gov/newsroom/blogs/research-matters/2024/12/ai-use-small-businesses.html); [Census CES working paper 2026](https://www2.census.gov/library/working-papers/2026/adrm/ces/CES-WP-26-25.pdf)
- Some commentators argue that the vendor and association figures overstate real adoption. For example, one headline says "89% use it, only 18% run it in production". [Blog] — [Gene Marks, Medium](https://genemarks.medium.com/small-businesses-adopting-ai-dont-believe-it-caf7dc3d4802); [Propane Insider](https://propaneinsider.com/newsletter/3437)

**What they use AI for**
- QuickBooks, April 2025: **marketing 43%, customer service 36%, administrative tasks 33%, data processing 32%, bookkeeping 29%**. Example offloadable tasks are categorising expenses, answering customer questions and drafting invoice reminder emails. — [QuickBooks](https://quickbooks.intuit.com/r/small-business-data/april-2025-survey/)
- US Chamber 2025: **54%** use AI marketing tools and another 27% plan to within 12 months. Marketing is the main entry point. — [IPWatchdog](https://ipwatchdog.com/2025/08/18/us-chamber-report-small-businesses-rapidly-adopting-ai-despite-regulatory-concerns/)
- India SME Forum 2025 describes AI chatbots handling routine customer queries in local languages, offered through Indian SaaS with vernacular interfaces and pay-per-use pricing. This is a descriptive claim, not a measured adoption rate. — [India SME Forum PDF](https://indiasmeforum.org/digishaastra/assets/docs/Final-META-Report-Card-2025.pdf)

**Barriers (OECD, the most rigorous source)**
- **OECD, "Generative AI and the SME Workforce: New Survey Evidence" (Nov 2025) [IGO; SMEs in G7 countries]:** among non-adopters, the barriers are **unsuitability to the SME's work (57%)**, **copyright, legal or regulatory concerns (54%)**, **concern about what happens to information fed into models (52%)** and **staff lack the skills (50%)**. About **80%** are concerned about data privacy, liability and misinformation. Fewer than **30%** of generative-AI-using SMEs train staff, ranging from 11.3% in Japan to 29.4% in Canada. Attitudes are not the blocker: **86%** are neutral or positive and only **2%** prohibit use. — [OECD report PDF](https://www.oecd.org/content/dam/oecd/en/publications/reports/2025/11/generative-ai-and-the-sme-workforce_83bafdfb/2d08b99d-en.pdf); [OECD chapter](https://www.oecd.org/en/publications/generative-ai-and-the-sme-workforce_2d08b99d-en/full-report/component-6.html) (403 when fetched; figures from the search summary)
- OECD, "AI adoption by SMEs" (Dec 2025) and OECD Cogito, "Agentic AI for small business growth" (Sep 2025) are related; I did not read them in full. — [OECD PDF](https://www.oecd.org/content/dam/oecd/en/publications/reports/2025/12/ai-adoption-by-small-and-medium-sized-enterprises_9c48eae6/426399c1-en.pdf); [OECD Cogito](https://oecdcogito.blog/2025/09/16/agentic-ai-for-small-business-growth/)
- Goldman Sachs: **44%** lack resources or expertise, and **76%** support government help with adopting AI. — [Fox Business](https://www.foxbusiness.com/economy/small-business-ai-adoption-jumps-68-owners-plan-significant-workforce-growth-2025)

### Inferences
- The realistic picture is that most small owners have *tried* ChatGPT-style tools for drafting (marketing copy, emails), but very few have AI wired into a workflow. The gap between 58–76% "use" and 9–14% "embedded or in production" is exactly the space a workflow tool like Jidoka would target.
- Data privacy and "what happens to my data" (52%) is a near-majority concern. Bring-your-own-AI and local-first storage (SQLite, single executable) are a real selling point and should be stated plainly in the product. Conversely, configuring a provider is a skills barrier (50% lack skills).
- "Unsuitable to our work" (57%) suggests generic chat AI doesn't map onto how owners think about their work. Per-type rules framed in the owner's own task vocabulary ("quote request", "booking change") may close that gap better than a general assistant.
- Micro-firms with 1–4 employees adopting fast (Census) suggests sole proprietors are a viable early segment. They are also the ones with the least time to configure rules.

### Gaps
- There is little non-US data on *which tasks* SMBs use AI for. The UK (DBT Longitudinal Small Business Survey, ONS BICS) and India could not be checked within budget.
- I found no data on SMB *trust* in AI acting autonomously (sending emails, chasing payments) as opposed to drafting. This matters for the AI-versus-human handling split.
- I did not open the Goldman Sachs, SBA Advocacy and OECD chapter pages (403). Their figures are taken from search summaries and press coverage.

---

## 5. Pain points that point to unmet needs (things falling through the cracks)

### Takeaway
The best-evidenced pain points are **late payment and chasing**, **missed or unanswered inbound requests** (especially phone), **regulatory paperwork** and **owner overload and dependency**. All of them come down to work arriving faster than one overloaded person can sort it, with no written process for anyone else to follow.

### Cited Findings
- UK: 28% of businesses hit by late payment, 86 hours a year chasing per affected business, 14,000 closures a year attributed to it. — [Small Business Commissioner / London Economics, Jul 2025](https://www.smallbusinesscommissioner.gov.uk/late-payments-research-2/)
- Xero ledger data: 29.3 days average to be paid in Q2 2026, about 9 days late. [snippet only] — [Xero](https://www.xero.com/us/guides/late-payment-small-business/)
- Missed calls: only about 38% of calls to small businesses are answered live, about 24% get no response, and 78% of consumers have abandoned a business after an unanswered call. [Vendor/agg] — [Oncrew](https://oncrew.ai/resources/missed-call-statistics); [this+that](https://www.thisandthat.chat/blog/small-business-communication-statistics)
- Regulation and red tape have been a top-three NFIB problem since 2009, and the owner is the de facto compliance officer. — [NFIB testimony](https://oversight.house.gov/wp-content/uploads/2018/03/Harned_NFIB-Testimony_03142018.pdf)
- Owners work 50+ hours (63%) and want about 42, and admin crowds out growth work ("twice as much time on admin as on growing the business", UK). [snippets] — [Agility PR](https://www.agilitypr.com/pr-news/pr-news-trends/time-management-new-survey-reveals-biz-owners-spending-time-theyd-rather-spend/); [Asian Trader](https://www.asiantrader.biz/small-business-owners-admin-burden)
- Indian MSMEs say the hardest part is **finding and setting up the right tools**, not getting customers or finance. — [India SME Forum PDF](https://indiasmeforum.org/digishaastra/assets/docs/Final-META-Report-Card-2025.pdf)
- Vendors' own examples of what to automate are quotes, staff scheduling, invoice reminders, expense categorisation and answering customer questions. These are revealed demand from the companies selling to this segment. — [Salesforce](https://www.salesforce.com/blog/small-business/ai-and-the-future-of-business/); [QuickBooks](https://quickbooks.intuit.com/r/running-a-business/agentic-ai-for-business/)

### Inferences (for the Jidoka alignment check)
- **Fits well:** a triage-then-playbook model for a mixed inbox where an owner or office manager must decide "what is this, and who handles it", then hand routine items to AI and route the rest to a named person. Professional services firms, agencies and B2B suppliers (email-heavy, written requests, recurring types such as quote requests, invoice queries, booking changes and supplier confirmations) are the closest match.
- **Gaps against this segment:**
  1. **Channels.** It needs WhatsApp Business, SMS and voicemail/phone, plus marketplace and social DMs for retail and hospitality. Email and GitHub alone cover only some of the workload outside professional services.
  2. **Non-message triggers.** Overdue invoices, filing deadlines and low stock come from the accounting ledger, the calendar or inventory, not from an inbound item. A "source" that polls Xero or QuickBooks for overdue invoices would cover the single best-evidenced pain point.
  3. **Setup burden.** BYO-AI keys, MCP configuration and rule review are a lot for this segment, which names setup and skills as the main barriers (India 36.8%, Goldman 44%, OECD 50%). It needs starter type and rule templates per vertical, and a simple default AI setup.
  4. **Trust and approval.** Given privacy and liability concerns (about 80% in OECD), owners are likely to want AI to *draft* (a payment reminder, a quote reply) while a human approves the send. This fits Jidoka's write-tool approval gate and its "pre-process, then hand to a human" pattern.
  5. **Delegation to named people.** In businesses with 1–10 staff, "human" means a specific person (owner, spouse, office manager, VA, accountant), so assignment needs named people.
- **Tacit knowledge is an opportunity.** Few small firms have written SOPs, but owners can describe their handling in plain language. Natural-language onboarding produces a documented, executable SOP as a by-product, and that addresses the owner-dependency problem.

### Gaps
- Owner-level qualitative research (interviews or ethnography) on how small businesses triage a mixed inbox was not found within budget.
- I found no rigorous measure of inbox volume per micro-business or of the share of enquiries that go unanswered by email.
- Reddit and forum colour was not collected.
