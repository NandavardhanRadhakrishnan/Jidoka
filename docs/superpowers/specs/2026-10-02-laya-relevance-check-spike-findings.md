# Spike findings: Laya for the relevance-check cheap gate

**Status:** spike complete, not pursued further for now. Written up so this doesn't need re-deriving if revisited.

## Context

While designing a "relevance check" (does a new/changed source item actually need the user's attention, vs. noise or a self-feedback loop — see the task-threads self-comment-loop incident that motivated this) and separately a way to keep triage cheap as a user's type registry grows, we considered [TypeSafe AI's Jev](https://jevtypesafeai.com/jev/classifier) (a hosted "System One" typed-decision model) and its open-source counterpart, **[Laya](https://github.com/NandhaKishorM/laya)** (Apache 2.0, ModernBERT/mmBERT-based, self-hostable, ~33ms/call, effectively $0 marginal cost). Both answer typed `choice`/`score`/yes-no-probability questions in one forward pass instead of generating text.

The appeal: a cheap, fast, local classifier could gate an expensive LLM call — either as "is this worth the user's attention" (relevance) or "which known type does this belong to" (cheap first-pass triage), only escalating to a real LLM call for the subset that needs it.

## Setup (for next time)

- `laya-ts` (the TypeScript/ONNX port) is **not yet published to npm** (tracked in [issue #288](https://github.com/NandhaKishorM/laya/issues/288)). Don't use the fork-based workaround in that issue (`github:SynthLuvr/laya`, an unofficial third party) — sparse-clone the `laya-ts` subdirectory from the official repo and build it locally instead (`git clone --filter=blob:none --sparse`, `git sparse-checkout set laya-ts`, `bun install`, `bunx tsc -p tsconfig.json`).
- `onnxruntime-node`/`protobufjs` have postinstall scripts Bun blocks by default — `bun pm trust onnxruntime-node protobufjs` needed before a build will actually run.
- **The published Hub checkpoint (`convaiinnovations/laya`) has no pre-exported ONNX files** — only raw `.safetensors`, across all three checkpoints (root/english, `multilingual/`, `typed-decisions/`). Despite the README implying `Agent.load("convaiinnovations/laya")` just works, it doesn't — you must run the one-time Python export (`python laya-ts/scripts/export_onnx.py --repo convaiinnovations/laya --out-dir ./model`) yourself. This needs `torch>=2.1` (a pre-existing 2.0.1 install failed silently-ish — transformers just disables itself with a warning), plus `onnxscript` and `onnxruntime` (not in the script's stated deps, surfaced as the export ran). A real Windows-console gotcha: the export script prints a ✅ emoji mid-run and crashes with `UnicodeEncodeError` on the default `cp1252` console encoding — set `PYTHONIOENCODING=utf-8` first.
- Third-party pre-exported ONNX uploads exist on the Hub (search `models?other=base_model:quantized:convaiinnovations/laya`) but use **incompatible file layouts** for official `laya-ts` (e.g. `receptron/laya-onnx` ships a single combined `laya.onnx`, not the split `encoder.onnx`+`head.onnx` the official package's providers expect) — not a safe shortcut without per-repo verification.
- Once exported, verification against the PyTorch reference was excellent: logit diffs of 3.6e-07 to 4.8e-07.

## What we tested, and what we found

All three tests used `convaiinnovations/laya`'s **default English checkpoint** (not the `typed-decisions` fine-tuned variant — a real gap, see Open questions).

**1. Relevance judgment ("is this comment addressed to user B", the A/B/C-on-a-GitHub-issue scenario) — weak.** Directionally sane ordering (self-authored lowest at 0.10, directly-addressed-to-B cases highest) but absolute confidence was mediocre everywhere (0.26-0.52) — even a message explicitly saying "B, can you confirm..." only scored 0.52, barely above chance. The library itself flagged this checkpoint's confidence as uncalibrated for the question types involved. **Conclusion: not reliable enough for a confidence-threshold gate.**

**2. Discrete type-choice classification — strong when categories are distinct, degrades with realistic tight clustering.**
- Against Jidoka's real 8-type registry (`jidoka.db`): **8/8** correct, confidence 0.985-1.000.
- Against an artificially broadened 20-type registry (spanning HR/security/marketing/finance/engineering — unrealistic for one person's actual job): **18/20** (90%), with the 2 misses being semantically reasonable adjacent-category confusions.
- Against a **realistic tightly-clustered 20-type registry** (one backend/devops engineer's job — 6 different flavors of "review a PR," multiple "something's broken in CI/deploy/prod" variants): **15/20 exact-match (75%)** — but by a looser and arguably more relevant bar ("did it pick *some* real type, correctly recognizing this is in-domain, vs. picking nothing"), **20/20**. The lesson: cardinality alone doesn't predict difficulty — semantic density of the registry matters as much or more, and a real individual's registry is tightly clustered, not diverse.
- Laya's own model card confirms a severe cardinality cliff for genuinely high-cardinality tasks: Banking77 (77 labels), Laya 0.425 vs. Jev 0.870 — consistent with the stated ">20 options" caution and the documented `head_max_len` token-budget-per-option mechanism (options become indistinguishable as their count grows past the budget). Official mitigation past 50 options: hierarchical two-step coarse-to-fine classification (not built or tested here).

**3. Open-set / "does anything match at all" detection (the actual capability a cheap gate needed) — unreliable, and not merely "sometimes wrong."** Added an explicit `no_matching_type` option to the 20-type registry and tested 5 genuinely out-of-domain requests (vacation request, broken coffee machine, subscription cancellation, press release review, team lunch planning) plus 3 real in-domain ones. Result: **5/8**, and the 3 misses were not boundary cases — a vacation request was filed as `on_call_escalation` at **0.999** confidence, "the coffee machine is leaking" was filed as `prod_incident_triage` at **1.000** confidence. These are maximum-confidence wrong answers on content with no real connection to the matched category — a confidence threshold would not have caught either. This looks like surface-level urgency/keyword pattern-matching rather than real domain understanding, and open-set recognition is a well-known hard problem for this class of model generally, not a Laya-specific defect.

**4. Baseline comparison — the real triage path, unchanged.** Ran the identical 8-case open-set test through Jidoka's actual `triageTask()` (real LLM via the existing `agent-sdk`/Claude-subscription path, no API key): **8/8**, including well-formed, sensibly-named new-type proposals for every out-of-domain case (`pto_request`, `facilities_maintenance_request`, `subscription_cancellation_request`, `press_release_review`, `team_event_logistics_coordination`) and the exact correct type (not just "a plausible one") on all 3 in-domain cases — including the two Laya got wrong.

## Decision

Dropped the "Laya gates whether full triage even runs" design. The premise required reliable open-set detection, which is exactly where it failed — sometimes at maximum confidence, which also rules out a confidence-based safety net. The system we already have handles the full test perfectly. The cost-optimization goal (avoid full-triage cost on obvious noise) isn't safely achievable this way; going with full triage's real cost rather than a cheap-but-unreliable gate in front of it.

## Where this might still fit later

- Laya's *validated* strength — choosing among options assuming one applies — could have a narrower home somewhere that doesn't require open-set judgment: e.g., once a human or the real triage LLM has already confirmed "this is in my domain," using Laya to pre-narrow a large registry to a shortlist before a final LLM call picks the exact type. Not designed or tested here.
- Untested mitigations worth trying before writing Laya off entirely: the `typed-decisions` fine-tuned checkpoint (we only tried the default English one, and the model card's own accuracy claims were measured on that checkpoint specifically), bumping `head_max_len` at runtime, and the hierarchical two-step approach Laya's own docs recommend past 50 options.
- Jev (the hosted, paid sibling) was never empirically tested here at all — only Laya. Its model card claims better high-cardinality and soft-distribution-matching performance than Laya; whether it does better on the *open-set* problem specifically is unknown and would need its own spike.

## Artifacts

Spike scripts lived under `.local/verify-scratch/` (gitignored, not committed, intentionally throwaway per the brainstorming skill's spike convention) — this document is the durable record. The real jidoka.db gained 12 extra `task_types` rows during the cardinality stress test (it was noted as fine to use since the db is still in a testing phase); these are real rows now, not cleaned up as part of this spike.
