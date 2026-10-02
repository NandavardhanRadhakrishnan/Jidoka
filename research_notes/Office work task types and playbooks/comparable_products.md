# Comparable products: inbound work -> classify -> route -> per-type playbook -> human/AI handling (benchmark for Jidoka)

Research date: 2026-10-02. Product state is moving fast; dates are flagged where the source gave one. Many third-party sources (eesel.ai, getmacha.com, myaskai.com, open.cx, fin.ai) are vendors of competing products and are biased; they are flagged where used.

## Q1. How do products represent "task type" / intent / topic, and how do they handle ambiguity, low confidence, and discovery of new types?

### Takeaway
The market has converged on **"type = short name + natural-language description (+ optional examples)" classified by an LLM**, replacing older trained-classifier taxonomies. Most helpdesks now **auto-discover a starter taxonomy from historical tickets and suggest new types over time** (Zendesk weekly suggestions, Front Topics, Help Scout Topics, UiPath clusters). Ambiguity handling is almost always a **confidence threshold -> fallback/human queue**, not an explicit "ask the user which of these two types" question as Jidoka does. Almost no product reclassifies existing items when the taxonomy changes (Help Scout explicitly does not).

### Cited Findings

**Salesforce Agentforce (topics -> renamed "subagents" April 2026)**
- A topic has three parts: a **Classification Description** (how the agent decides to use this topic), **Scope** (what the agent can do in it), and **Instructions** (what/when/how to act once chosen). — [Salesforce developer blog, Jan 2025](https://developer.salesforce.com/blogs/2025/01/how-to-write-effective-natural-language-instructions-for-agentforce)
- Routing is an LLM prompt that matches the message (with conversation history) against each subagent's name + classification description; an automatic **"Off Topic"** subagent catches unmatched utterances. "Beginning in April 2026, agent Topics are now called Subagents and the Topic Selector is now called Agent Router." — [Salesforce, Levels of Determinism](https://www.salesforce.com/agentforce/levels-of-determinism/)
- Actions attached to a topic can be Apex, API calls, Flows, prompt templates, or predictive models. — [Salesforce developer blog](https://developer.salesforce.com/blogs/2025/01/how-to-write-effective-natural-language-instructions-for-agentforce)

**Zendesk intelligent triage (intent / sentiment / language / entities)**
- Originally used **predefined, industry-specific intent taxonomies** (eCommerce, software, banking, insurance, travel, employee experience, etc.) with High/Medium/Low confidence; requires Suite/Support Professional + Advanced AI add-on, min 1,000 end-user tickets in 6 months; intent/sentiment in ~30 languages. — [Swifteq guide (third party)](https://swifteq.com/post/zendesk-intelligent-triage)
- Now supports **custom intents ("topics")**: name (<=255 chars), description (<=650 chars, "explaining what the topic includes/excludes"), three-level category/subcategory hierarchy, max **500** custom topics per account; guidance says each topic must "represent a single use case" and descriptions must be "clear and unambiguous". Classification is on Professional+; using it in workflows requires the Copilot add-on. Docs do not say whether existing tickets are reclassified when topics change. — [Zendesk help: custom intents](https://support.zendesk.com/hc/en-us/articles/8718789695002-Personalizing-intelligent-triage-by-creating-custom-intents)
- **Suggested intents**: "Intelligent triage now suggests new intents weekly in the Intent page", highlighting coverage gaps based on historical ticket data (2025). Admins can also define synonyms for entity values. — [Zendesk 2025 recap (via search summary)](https://support.zendesk.com/hc/en-us/articles/10140103140122-2025-recap-What-s-new-in-Zendesk); [Announcing intent suggestions](https://support.zendesk.com/hc/en-us/articles/9484677395482-Announcing-intent-suggestions-for-Zendesk-Copilot-customers) (page 404'd on fetch; title only)
- Confidence threshold for AI agent intents: legacy range 0-100, default 60; below threshold the fallback applies. Consultants suggest 70-80% for routing. — [eesel.ai (competitor, anecdotal)](https://www.eesel.ai/blog/zendesk-ai-agent-intent-confidence-threshold)

**Front**
- Legacy **AI Tagging** (up to 50 tags per inbox, AI reads subject + body only) is no longer available to new users; replaced by **Topics** + "Branch by Autopilot". — [Front help: AI Tagging legacy](https://help.front.com/en/articles/759488)
- Topics are AI-generated contact reasons; per a third-party guide, Front scans up to 10,000 conversations from the past 30 days, auto-suggests Topics, and the admin reviews, renames and merges duplicates. — [getmacha.com summary via search (third party)](https://www.getmacha.com/blog/how-to-set-up-tags-in-front)
- "Branch with Autopilot": the admin writes a yes/no or multiple-choice question in natural language and the AI answers it to branch a rule. — [Front help: Autopilot features in rules](https://help.front.com/en/articles/3811840)
- Front's head of AI: "Within seconds of a message coming in we figure out the topic and label the message." — [No Jitter](https://www.nojitter.com/ai-automation/front-s-topics-agent-put-ai-powered-automation-front-and-center)

**Help Scout Topics (BETA, doc updated 2026-09-28)**
- Auto-generates ~8-15 topics per inbox from history, scans daily for emerging patterns; admins can edit emoji/name/description, add custom topics, or disable topics. "Manual changes do not currently feed back into the AI model during the beta." **Existing conversation classifications persist when topics change**; disabled topics remain on prior conversations. Topics usable only as a workflow *condition*, not action. Plus/Pro plans. — [Help Scout docs](https://docs.helpscout.com/article/1773-categorize-conversations-automatically-with-ai-topics)

**UiPath Communications Mining (banks/insurers email intent)**
- After ingest, the platform shows **30 clusters** of messages it believes share concepts/intents; users annotate whole clusters at once to bootstrap the taxonomy. — [UiPath docs: training using clusters](https://docs.uipath.com/communications-mining/automation-cloud/latest/user-guide/training-using-clusters) (from search snippet; page 404'd on direct fetch)
- **Generative Annotation** (Azure OpenAI) adds "Cluster Suggestions" (suggested new or existing labels for clusters) and "Assisted Annotating" (predictions from label names/descriptions). — [UiPath docs: Generative Annotation](https://docs.uipath.com/communications-mining/automation-cloud/latest/user-guide/generative-annotation-new)
- Typical datasets have **50-100 labels**; guidance: name labels specifically, keep the taxonomy flat at first and restructure into hierarchy later. — [UiPath docs: taxonomy design](https://docs.uipath.com/communications-mining/automation-cloud/latest/user-guide/taxonomy-design-best-practice)
- Robots use Communications Mining output to triage emails, update customer info, create cases; Hiscox reportedly cut process lead time "by 300%". — [UiPath insurance page / search summary](https://www.uipath.com/solutions/industry/insurance-automation)

**ServiceNow (ITSM)**
- Classic **Predictive Intelligence** classification models trained on historical incidents predict category, priority, assignment group. — [ServiceNow Community](https://www.servicenow.com/community/now-assist-forum/now-assist-vs-predictive-intelligence/td-p/3500993)
- Community pattern (Now Assist): an agentic workflow runs three methods in parallel (semantic search over similar resolved incidents, PI classifier, matching against **assignment-group descriptions**), an LLM picks one with a confidence score; **>=80% auto-updates** the assignment group and logs reasoning in work notes, otherwise not. — [ServiceNow Community article](https://www.servicenow.com/community/now-assist-articles/multi-method-assignment-group-prediction-with-now-assist/ta-p/3562536)

**Jira Service Management**
- Email requests arrive as a generic "Emailed request" type; **AI triage** lets an agent select queue items, see Atlassian Intelligence's suggested request types (and field fills), review, and Apply in bulk. — [Atlassian docs](https://support.atlassian.com/jira-service-management-cloud/docs/update-the-request-types-of-issues-using-atlassian-intelligence/)
- Rovo "Request Router" agent recommends request type, urgency, priority and routes to queue/assignee. — [Atlassian AI guide (search summary)](https://www.atlassian.com/software/jira/service-management/product-guide/tips-and-tricks/artificial-intelligence)

**HubSpot Service Hub**
- Help Desk "Category identification" toggle auto-categorizes tickets from the first message; Breeze/Customer Agent routes by intent you define. — [HubSpot AI routing page (search summary)](https://www.hubspot.com/products/artificial-intelligence/use-cases/review-and-route-tickets)

**Linear (Triage Intelligence)**
- Uses search + ranking + LLM reasoning against the workspace's **historical issues** to suggest team, assignee, labels, and likely duplicates/related issues; each suggestion shows plain-language reasoning; accept/decline individually; specific suggestion types can be set to **auto-apply for high-confidence cases**. — [Linear docs: Triage](https://linear.app/docs/triage); [How we built Triage Intelligence](https://linear.app/now/how-we-built-triage-intelligence)

**Personal inbox tools**
- Superhuman (April 2025): built-in Auto Labels (respond, waiting on, meetings, marketing, ...) plus **Custom Auto Labels defined by a short prompt** ("job applications") that can drive a Split Inbox tab; labels can be edited, previewed, "trained". Custom labels on Business/Enterprise only. — [AlternativeTo news](https://alternativeto.net/news/2025/4/superhuman-s-new-update-brings-auto-reminders-auto-drafts-auto-labels-and-auto-archive/); [Superhuman on X](https://x.com/Superhuman/status/1912920953186910587)
- Outlook Copilot "Prioritize my inbox": High/Normal/Low with a **plain-English instruction box** defining what high priority means. — [Microsoft support](https://support.microsoft.com/en-us/topic/prioritize-my-inbox-65e37040-2c90-4ee3-86d9-e95d5ba0e3cb); [Gethyn Ellis, Sept 2026](https://www.gethynellis.com/2026/09/copilot-outlook-inbox-management/)
- Shortwave "AI Filters": plain-English rules that label/archive/star/prioritize. — [Shortwave](https://www.shortwave.com/#r)

**DIY automation (Power Automate, n8n)**
- Power Automate/AI Builder: either a trained "Classify text into custom categories" model (>=2 tags, >=10 samples each, up to 200 tags) or a GPT prompt listing categories + examples returning JSON. — [Microsoft Learn](https://learn.microsoft.com/en-us/training/modules/ai-builder-category-classification/exercise); [PowerGI blog](https://powergi.net/blog/power-automate-and-ai-prompts-email/)
- n8n templates use a "Text Classifier" node with a fixed category list (e.g. Internal / Customer Support / Sales / Promotions / Admin-Finance) then route each branch to a separate LLM agent. — [n8n templates (search summary)](https://n8n.io/workflows/3242-smart-email-classifier-and-auto-responder-with-ai/)

### Inferences
- **Jidoka matches** the dominant modern representation (name + description + examples, LLM-classified) — this is essentially Agentforce's "classification description" and Zendesk's custom topic (name + includes/excludes description).
- **Jidoka is ahead** on: (a) explicit ambiguity questions to the user (others use a single confidence threshold + fallback queue), (b) saving the user's choice as a new example (Help Scout explicitly says manual changes do *not* feed back in beta), (c) re-triaging open tasks on type change (no product found does this; Help Scout explicitly keeps old classifications).
- **Jidoka lacks**: (1) **bulk discovery from history** — Front, Help Scout, Zendesk, UiPath all bootstrap a taxonomy by clustering past items (30 clusters / 8-15 topics / 10k convos) rather than discovering one task at a time; (2) **an "off-topic / none of the above" catch-all** as a first-class type (Agentforce); (3) **hierarchy** (Zendesk three-level categories, UiPath hierarchical labels); (4) **multiple orthogonal classifications** — intent plus sentiment, language, urgency/priority, entities are separate axes in Zendesk/Jira/Outlook; Jidoka has only "type"; (5) **duplicate/related-item detection** (Linear); (6) **per-suggestion-type auto-apply on high confidence** (Linear, ServiceNow 80% pattern) as a configurable knob.
- Taxonomy size reference points: Help Scout 8-15, Front tags 50/inbox, UiPath 50-100, Zendesk up to 500. Jidoka's one-type-at-a-time discovery may need a near-duplicate guard (already an open decision) — weekly batch suggestion (Zendesk) is one way products avoid proposal spam.

### Gaps
- Could not confirm from a primary source how Front's Topics review/merge flow works (only third-party summary) or whether Zendesk re-classifies tickets after a custom topic edit (docs silent).
- Could not fetch the Zendesk "intent suggestions" announcement (404); weekly cadence is from the search snippet of Zendesk's own 2025 recap.
- Communications Mining docs pages 404'd on direct fetch; cluster count (30) is from the search snippet of the official doc.

## Q2. How are playbooks authored, versioned, tested, and approved before activation?

### Takeaway
2025-2026 brought a clear convergence among AI-native CX vendors (Intercom Fin Procedures, Decagon AOPs, Sierra Journeys, Agentforce instructions + Agent Script, Front Agent): **natural-language SOPs with embedded deterministic controls (code conditions, flows, sub-procedures)**, often **generated from existing SOP documents or transcripts by an AI copilot**, then gated by **simulation suites, versioning, and reviewer approval**. Enterprise orchestration (ServiceNow, UiPath Maestro) stays visual/BPMN with AI agents as one activity type. Jidoka's "AI builds a declarative rule from an NL description, user reviews before activation" sits between these: it matches the generate-from-NL pattern but has no simulation/regression testing.

### Cited Findings

**Intercom Fin Procedures (Fin 3, 2025)**
- Procedures combine natural-language instruction steps with **code conditions**, **data connectors** (API actions), **sub-procedures**, **human-in-the-loop approvals**, **Simulations**, and "Manage procedure versions and publishing". Triggerable from the Inbox, proactively from website/API, or from Workflows. — [Intercom help: Fin Procedures explained](https://www.intercom.com/help/en/articles/12495167-fin-procedures-explained)
- Simulations: "fully simulated customer conversations from start to finish", saved to a central library "to rerun them whenever you update a Procedure". — [Intercom blog: What's new with Fin 3](https://www.intercom.com/blog/whats-new-with-fin-3/)
- Intercom distinguishes Procedures vs Tasks (being transitioned away from) vs Workflows (deterministic visual builder), with articles on "When to move complex logic from Workflows to Procedures". — [Intercom help](https://www.intercom.com/help/en/articles/14077835-procedures-vs-tasks-vs-workflows)
- Intercom's own comparison claims Procedures are written "the way they would train a new teammate" and that support teams build them without engineering. It also states Fin changes deploy "immediately" — **this conflicts** with Intercom's help center listing a versions-and-publishing feature. — [fin.ai comparison (Intercom-published, biased)](https://fin.ai/learn/ai-agent-procedures-aops-journeys)

**Decagon AOPs (Agent Operating Procedures)**
- AOPs (blog dated 2025-04-08) "merge conversational instructions with code-based logic", with "built-in safeguards — executing key validation steps in code"; business users write NL while engineers build integrations in parallel. — [Decagon blog](https://decagon.ai/blog/why-we-built-aop)
- Testing: unit tests per AOP component, **regression tests replaying historical transcripts against new versions**, simulated conversations with AI-generated personas, live **A/B traffic splits**. — [Decagon (search summary)](https://decagon.ai/resources/the-future-of-ai-agents-is-test-driven)
- "AOP Copilot can convert rough notes or existing SOPs into production-ready AOPs." — [fin.ai comparison (biased)](https://fin.ai/learn/ai-agent-procedures-aops-journeys)

**Sierra (Agent Studio / Journeys / Agent SDK)**
- Journeys: CX teams describe goals in plain English in Agent Studio; Ghostwriter generates workflows from SOPs or transcripts; Agent SDK for developers. Journeys, config and simulations are **versioned automatically**; GitHub-style Workspaces. Simulations auto-generate test cases when an agent is created and can run in CI (GitHub Actions/CLI) and **gate releases**. — [Sierra Agent Studio 2.0](https://sierra.ai/blog/agent-studio-2-0); [Sierra Simulations](https://sierra.ai/blog/simulations-the-secret-behind-every-great-agent)
- Release governance (2026-08-20): every release is an **immutable snapshot** with rollback; **merge approval workflows** with a Reviewer role (CX lead, compliance, eng manager) who inspects diffs and comments; **split-traffic staged rollouts**; simulations as required gates; **"Agent Checks"** linter flags e.g. "a tool your prompt references but never made available, conflicting instructions". — [Sierra blog](https://sierra.ai/blog/release-governance-guardrails-for-agents-at-scale)

**Salesforce Agentforce**
- Six "levels of determinism": (1) instruction-free topic/action selection, (2) instructions, (3) data grounding/RAG, (4) agent variables, (5) deterministic actions (Flows/Apex/APIs), (6) **Agent Script** — hybrid reasoning with if/else, forced transitions, before/after-reasoning blocks, explicit variable state. — [Salesforce](https://www.salesforce.com/agentforce/levels-of-determinism/)
- **Testing Center**: batch test cases map Utterance -> Expected Topic / Expected Actions / Expected Response (CSV); can auto-generate hundreds of synthetic utterances and run them in parallel. — [Salesforce Admins blog, 2025](https://admin.salesforce.com/blog/2025/ensuring-ai-accuracy-5-steps-to-test-agentforce); [DevOps Digest](https://www.devopsdigest.com/salesforce-introduces-agentforce-testing-center)

**Front Agent (announced for fall 2025)**
- "Our customers know what they want to happen. They would rather codify [those SOPs] once and then just have AI trigger them." — Kevin Yang, Front head of AI. — [No Jitter](https://www.nojitter.com/ai-automation/front-s-topics-agent-put-ai-powered-automation-front-and-center)

**ServiceNow**
- **Agentic Playbooks** (Zurich release) embed AI agents as activities inside deterministic playbooks; "The agent does the research and proposes actions, while the human confirms." Any AI agent/orchestrator action can be set **supervised** (wait for human approval) or unsupervised. Built in Workflow Studio (Flow Designer, Process Automation Designer, Decision Builder). — [ServiceNow Community CoE](https://www.servicenow.com/community/workflow-automation-articles/getting-started-with-agentic-playbooks-workflow-automation-coe/ta-p/3469878); [ServiceNow Agentic Playbooks](https://www.servicenow.com/platform/agentic-playbooks.html)

**UiPath Maestro**
- BPMN 2.0 process models + DMN business rules; coordinates robots, third-party agents, humans; supports pause/resume/retry/rewind/skip on live instances with audit trail. — [UiPath Business Orchestration](https://www.uipath.com/platform/agentic-automation/business-orchestration)

**Zapier / Lindy (SMB)**
- Zapier Agents: **draft and published versions** (beta in 2025, GA end of year); December 2025 added checkpoint versioning with one-click rollback for Copilot's agent edits and **MCP tool bundle sharing**. — [Zapier Dec 2025 updates](https://zapier.com/blog/december-2025-product-updates/)
- Lindy: describe the agent in plain English and Lindy builds it; 50+ templates. G2 reviewer: "when Lindy makes errors while building agents, it costs a lot of credits". — [Lindy blog](https://www.lindy.ai/blog/ai-email-triage); [getmacha review (third party)](https://www.getmacha.com/blog/lindy-ai-complete-guide)

### Inferences
- **Jidoka matches**: NL description -> agent-built rule (like AOP Copilot, Sierra Ghostwriter, Lindy, Zapier Copilot); declarative + versioned; review before activation; called sub-rules (Fin sub-procedures); deterministic steps mixed with AI steps (Agentforce levels 5-6, Fin code conditions). Jidoka's compile-once / no per-task regeneration is the same principle as "codify SOPs once and have AI trigger them" (Front) and Decagon compiling NL into executable logic.
- **Jidoka lacks**: (1) **simulation/regression testing** — every serious vendor has it (Fin Simulations, Decagon transcript replay, Sierra auto-generated suites gating releases, Agentforce Testing Center with Expected Topic/Actions). Jidoka already stores real tasks per type, so "replay the last N tasks of this type against the new rule version and diff the outcome" is a cheap, high-value analogue; (2) **triage test sets** ("utterance -> expected type") for the classifier itself; (3) **a linter** for rules (Sierra Agent Checks: referenced-but-unavailable tool, conflicting instructions) — Jidoka's MCP allowlist check at activation is a partial analogue; (4) **staged rollout / A/B** (Sierra, Decagon) — likely unnecessary for single-user Jidoka; (5) **generating a rule from an existing SOP document** rather than a fresh description.
- Representation trade-off: competitors keep the playbook as NL with embedded code (the LLM interprets at runtime); Jidoka compiles NL into explicit declarative steps. Jidoka's approach is closer to Agentforce Agent Script / ServiceNow playbooks (more inspectable/deterministic) and further from Fin/Decagon (more flexible).

### Gaps
- No primary source found on how Fin/Decagon select which procedure to run (trigger description vs classifier); fin.ai comparison explicitly omits it.
- Decagon testing details come from a search summary of Decagon's own page, not a full fetch.

## Q3. Human-in-the-loop patterns

### Takeaway
The common patterns are: **(a) confidence threshold -> auto-apply vs human queue**, **(b) draft-for-review (AI drafts, human sends)**, **(c) per-action approval gates ("supervised" actions)**, **(d) suggestion-with-reasoning that a human accepts/declines**, and **(e) escalation with full context handed over**. Trust is typically loosened incrementally per action type.

### Cited Findings
- ServiceNow: AI agent/orchestrator actions can be configured **supervised** (wait for human approval) or unsupervised; agentic playbooks: agent researches and proposes, human confirms. — [ServiceNow CoE](https://www.servicenow.com/community/workflow-automation-articles/getting-started-with-agentic-playbooks-workflow-automation-coe/ta-p/3469878)
- ServiceNow community pattern: LLM confidence >=80% auto-sets assignment group and writes reasoning to work notes. — [ServiceNow Community](https://www.servicenow.com/community/now-assist-articles/multi-method-assignment-group-prediction-with-now-assist/ta-p/3562536)
- Linear: every triage suggestion carries plain-language reasoning; accept/decline per suggestion; selected suggestion types can auto-apply when confident. — [Linear docs](https://linear.app/docs/triage)
- Jira SM: bulk AI triage is suggest-then-Apply by a human. — [Atlassian docs](https://support.atlassian.com/jira-service-management-cloud/docs/update-the-request-types-of-issues-using-atlassian-intelligence/)
- Intercom Fin Procedures: "Human-in-the-loop approvals" before actions execute. — [Intercom help](https://www.intercom.com/help/en/articles/12495167-fin-procedures-explained). On escalation, "human agent receives the full conversation thread, all retrieved data, and the Procedure's reasoning trail". — [fin.ai (biased)](https://fin.ai/learn/ai-agent-procedures-aops-journeys)
- Lindy: triage is fully autonomous; replies are **drafts by default** saved to your drafts folder; custom agents have **per-step confirmation toggles "you can loosen as trust builds"**. — [Lindy blog / search summary](https://www.lindy.ai/blog/ai-email-triage)
- Zapier: Human-in-the-Loop approval step that pauses a Zap; guest reviewers can approve via secure link without a Zapier account (Dec 2025); agent steps show a "needs review" state. — [Zapier help](https://help.zapier.com/hc/en-us/articles/38731463206029-Request-approval-to-keep-your-workflow-running-with-Human-in-the-Loop); [Zapier Dec 2025](https://zapier.com/blog/december-2025-product-updates/)
- UiPath Maestro: low-confidence AI or exceptions route to Action Center for review/approval; HITL works across BPMN, Case Management, Flow, Agents. — [UiPath](https://www.uipath.com/platform/agentic-automation/business-orchestration)
- Zendesk: auto-reply only on high-confidence intents; low-confidence flagged for manual review. — [Swifteq (third party)](https://swifteq.com/post/zendesk-intelligent-triage)
- Superhuman Auto Drafts and Outlook Copilot draft instructions: AI drafts, user sends. — [AlternativeTo](https://alternativeto.net/news/2025/4/superhuman-s-new-update-brings-auto-reminders-auto-drafts-auto-labels-and-auto-archive/); [Gethyn Ellis](https://www.gethynellis.com/2026/09/copilot-outlook-inbox-management/)

### Inferences
- **Jidoka matches**: ambiguity -> ask user; "pre-process then assign to human" (same as ServiceNow "agent researches, human confirms" and Fin's handoff-with-context); write-tool approval gate at rule activation (recent commit 059a92d) is a coarse version of "supervised actions".
- **Jidoka lacks**: (1) **per-execution approval** of individual write actions (Fin, ServiceNow supervised, Zapier HITL step, Lindy per-step toggles) — Jidoka approves at activation time, not per run; (2) **draft-for-review as a first-class outcome** (AI prepares a reply, human sends) — likely the single most common real-world pattern; (3) **visible reasoning on every classification** (Linear) so the user can audit; (4) a **trust ladder** — per type/per action auto-apply once accuracy is proven; (5) a configurable **confidence threshold** knob.

### Gaps
- No quantitative data found on what share of users keep approval gates on vs turn them off.

## Q4. What do users actually build (templates, case studies, community)?

### Takeaway
Real usage concentrates on a small set of patterns: **lead/sales-inquiry handling, support triage + FAQ auto-reply with escalation, extract-summarize-file (invoices, attachments, resumes), and personal inbox sorting (needs reply / waiting / meetings / newsletters / auto-archive)**. Category sets in templates are generic and small (5-8 buckets). Enterprise intent use cases are domain-specific (claims, payment disputes, broker emails).

### Cited Findings
- Zapier analysis of 10,000 AI-powered workflows (March 2026): ~30% combined messaging + organization in a **lead management** system (top use case); ~30% extracted, summarized and organized information (resume scanning, meeting notes, document sorting, follow-ups); ~20% responded to messages (tailored sales replies, support FAQs, flagging complex issues for humans). — [Business Wire / Morningstar](https://www.morningstar.com/news/business-wire/20260311671260/zapier-analysis-of-10000-ai-powered-workflows-reveals-lead-management-as-the-top-use-case-for-ai-automation)
- Zapier enterprise survey: top agent uses — data management/entry/extraction 47%, document analysis & summarization 41%, **customer support triage & response 41%**, report generation 36%; 72% of enterprises using or testing agents. — [Zapier/Yahoo Finance](https://finance.yahoo.com/news/zapier-survey-finds-84-enterprises-130000504.html); [Zapier blog](https://zapier.com/blog/ai-agents-survey/)
- n8n popular email templates: "AI Email Dispatcher" (Sales / Support / Internal / Finance / Promotions -> a dedicated LLM agent per category); "Smart Email Classifier & Auto-Responder" (Spam, Important, Promotion, Notification, Personal, Call Request, Needs Reply); multi-account classifier with High/Medium/Low priority into Google Sheets + Discord; MIS agent routing attachments to Drive folders. — [n8n templates](https://n8n.io/workflows/3242-smart-email-classifier-and-auto-responder-with-ai/); [n8n MIS agent](https://n8n.io/workflows/4341-ai-powered-mis-agent/)
- Lindy templates: lead follow-ups, lead qualification, support ticket dispatching, meeting requests, forwarding invoices to accounting. — [Lindy](https://www.lindy.ai/tools/ai-email-management)
- Superhuman default Auto Labels: respond, waiting on, meetings, marketing, cold pitches, social updates; custom examples "job applications", "requests to review work". — [AlternativeTo](https://alternativeto.net/news/2025/4/superhuman-s-new-update-brings-auto-reminders-auto-drafts-auto-labels-and-auto-archive/)
- Outlook Copilot priority examples: "emails from my manager", "project X", deadlines within five working days = high; newsletters, automated notifications, calendar acceptances = low. — [Gethyn Ellis](https://www.gethynellis.com/2026/09/copilot-outlook-inbox-management/)
- Zendesk triage uses: high-confidence auto-replies, language routing, intent -> department, escalation on intent + unresolved history, webhook forwarding for GDPR/unsubscribe. — [Swifteq](https://swifteq.com/post/zendesk-intelligent-triage)
- Enterprise: Communications Mining classifies broker, policyholder and claims email and routes with structured context; CommBank uses agentic AI to lodge payment disputes when criteria are met. — [UiPath insurance (search summary)](https://www.uipath.com/solutions/industry/insurance-automation)
- Personal task managers stop at capture: Asana forward-to x@mail.asana.com (subject -> name, body -> description, attachments carried); Outlook flagged email -> task via Zapier/Power Automate; Planner cannot attach a flagged email directly. No classification or playbook. — [Asana help](https://help.asana.com/s/article/use-asana-and-email?language=en_US); [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/5852416/attaching-flagged-emails-to-a-planner-task)

### Inferences
- Jidoka's likely highest-value starter types for office work mirror these: needs-reply, meeting/scheduling request, FYI/newsletter (auto-archive), invoice/document-to-file, lead/sales inquiry, support/request from internal colleague, approval request. Shipping a few **starter types + rule templates** would match every competitor's onboarding (template galleries are universal; Jidoka currently starts empty).
- The commonest playbook shape is "classify -> extract/summarize -> draft reply or file it -> flag the hard ones for a human" — exactly Jidoka's pre-process-then-assign; the missing piece is the draft-reply outcome.
- Personal task managers (Asana, Todoist, Planner) are a weak benchmark: no typing or rules; Jidoka's gap vs them is ingestion convenience (forward-to-address, flag-to-task), not intelligence.

### Gaps
- Could not get ranked template popularity from Zapier/Make/n8n galleries (no public usage counts found); n8n list is from search results, not ranked.
- No published distribution of how many types/intents a typical SMB or individual user ends up with.

## Q5. Pricing, target segment, and user complaints (anecdotal)

### Takeaway
AI triage/agent capability is priced as an **add-on on top of seats** in helpdesks (Zendesk Advanced AI/Copilot, Help Scout Plus/Pro, Superhuman Business) and increasingly **per outcome/action** (Fin $0.99/outcome, Zendesk ~$1.50-2/resolution, Agentforce $0.10/action) or **credits** (Lindy, Zapier). The loudest complaints are **unpredictable bills that grow with success**, **resolution numbers that overstate value**, and **reliability of multi-step chains**. Jidoka's bring-your-own-provider model sidesteps vendor markup but inherits the "cost of LLM calls per task" concern.

### Cited Findings
- Intercom Fin: $0.99 per outcome plus seats; Reddit threads "Why my Intercom bill jumped from $4k to $9k/month", "My Intercom billing shot up by 120%, it was because of AI"; concern that unanswered conversations count as "resolved". — [ClearFeed (third party)](https://clearfeed.ai/blogs/intercom-pricing); [getmacha (competitor)](https://www.getmacha.com/blog/intercom-fin-pricing)
- Zendesk AI agents: ~$2/resolution PAYG or ~$1.50 committed; seats $19-$115/agent/month; Zendesk community poster: "$7,500 to $10,000/month, just for automated resolutions ... a massive bait-and-switch"; claimed real-world autonomous resolution 10-20% vs marketed 50-80% (competitor claim, treat as anecdotal). — [open.cx (competitor)](https://www.open.cx/blog/zendesk-ai-agents-review)
- Zendesk intelligent triage needs Professional+ plus add-on and >=1,000 tickets in 6 months — i.e., not for small volumes. — [Swifteq](https://swifteq.com/post/zendesk-intelligent-triage)
- Agentforce Flex Credits (from 2025-05-15): $500 per 100k credits; standard action = 20 credits ($0.10), voice action $0.15. — [Salesforce press release](https://www.salesforce.com/news/press-releases/2025/05/15/agentforce-flexible-pricing-news/); [search summary of pricing guides](https://magicfuse.co/blog/agentforce-cost)
- Lindy: G2 4.9 (171 reviews) vs Trustpilot 1.7 (39 ratings, 77% one-star); complaints: credits exhausted ("kill my months credits (3000) in one day"), credits burned by build errors and failed loops, OAuth tokens failing on recurring triggers, emails sent to wrong recipients, label bugs causing missed emails; Reddit: "solid for straightforward routines but unreliable for complex chaining". — [getmacha (competitor)](https://www.getmacha.com/blog/lindy-ai-complete-guide); [usecarly](https://www.usecarly.com/blog/lindy-ai-review/)
- Superhuman custom auto labels and auto drafts gated to Business/Enterprise plans. — [Superhuman on X](https://x.com/Superhuman/status/1911858000677273647)
- Help Scout Topics only on Plus/Pro. — [Help Scout docs](https://docs.helpscout.com/article/1773-categorize-conversations-automatically-with-ai-topics)
- Segments: Sierra/Decagon/Agentforce/ServiceNow/UiPath target enterprise (Sierra cites a major airline, travel marketplace, fintech using split-traffic releases); Zapier/n8n/Lindy/Superhuman target SMB/individuals. — [Sierra](https://sierra.ai/blog/release-governance-guardrails-for-agents-at-scale)
- Zapier survey: security and data privacy are the biggest barriers to agent adoption. — [Zapier/Yahoo](https://finance.yahoo.com/news/zapier-survey-finds-84-enterprises-130000504.html)

### Inferences
- Jidoka's position (single user, BYO model, local Bun binary, MCP for actions) has no direct equivalent: enterprise CX platforms are customer-facing and seat+outcome priced; SMB tools (Lindy, Zapier) are cloud credit-priced. The closest analogues are n8n self-hosted + an LLM, or Superhuman/Outlook Copilot for personal triage — none of which combine an evolving type registry with per-type compiled rules.
- Lindy's complaint profile (credits burned by agent build errors, wrong-recipient sends, broken recurring auth) is a direct warning for Jidoka: rule-building cost, write-action safety, and long-lived OAuth refresh are where trust is lost.
- Privacy as the top barrier favours Jidoka's local-first, BYO-provider design.

### Gaps
- Pricing figures for Zendesk and Lindy come mostly from competitor-authored blogs; primary pricing pages were not fetched.
- G2/Reddit complaints are anecdotal and selected by biased aggregators; no systematic review data gathered for Front, Help Scout, Linear, UiPath, ServiceNow in this pass.
- Decagon and Sierra pricing not found (both sell via enterprise contracts).
