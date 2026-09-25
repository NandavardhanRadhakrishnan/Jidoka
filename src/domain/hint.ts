export interface Hint {
  id: string;
  ruleId: string;
  /** The exact step id within that one rule's definition. Unique within a rule
   *  (RuleStepSchema requires it, and the builder rejects duplicates), so this
   *  is unambiguous in a way an output name is not (nothing stops two steps
   *  sharing an output name today). */
  stepId: string;
  text: string;
  /** What the human had selected when writing it, if anything — reference only, never
   *  matched against at runtime. */
  excerpt: string | null;
  createdAt: string;
}

export interface NewHint {
  ruleId: string;
  stepId: string;
  text: string;
  excerpt?: string | null;
}
