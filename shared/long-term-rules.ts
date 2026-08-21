export type LongTermRuleScope = 'global' | 'agent';

export type LongTermRule = {
  id: string;
  scope: LongTermRuleScope;
  agentId?: string;
  content: string;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LongTermRuleContext = {
  agentId: string;
  workspaceRoot: string;
};

// Rule content is intentionally returned only for the current Agent plus global rules.
// This keeps a per-Agent rule from leaking into another Agent's Settings surface.
export type LongTermRuleListPayload = LongTermRuleContext;

export type LongTermRuleListResult = {
  status: 'enabled' | 'disabled';
  rules: LongTermRule[];
};

export type LongTermRuleCreatePayload = LongTermRuleContext & {
  scope: LongTermRuleScope;
  content: string;
};

export type LongTermRuleUpdatePayload = LongTermRuleContext & {
  id: string;
  content?: string;
  enabled?: boolean;
};

export type LongTermRuleDeletePayload = LongTermRuleContext & { id: string };
export type LongTermRuleUndoPayload = LongTermRuleContext & { undoToken: string };
export type LongTermRuleCapturePayload = LongTermRuleContext & { message: string };

export type LongTermRuleMutationResult = {
  rules: LongTermRule[];
  undoToken?: string;
  disabled?: true;
};

export type LongTermRuleCaptureResult = LongTermRuleMutationResult & {
  captured: boolean;
  rule?: LongTermRule;
};
