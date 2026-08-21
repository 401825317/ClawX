import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type {
  LongTermRuleCapturePayload,
  LongTermRuleCreatePayload,
  LongTermRuleDeletePayload,
  LongTermRuleListPayload,
  LongTermRuleUpdatePayload,
  LongTermRuleUndoPayload,
} from '../../shared/long-term-rules';
import { longTermRuleService } from './long-term-rule-service';
import { isRecord } from './payload-utils';

function requireContext(payload: unknown): asserts payload is Record<string, unknown> & {
  agentId: string;
  workspaceRoot: string;
} {
  if (
    !isRecord(payload)
    || typeof payload.agentId !== 'string'
    || typeof payload.workspaceRoot !== 'string'
  ) throw new Error('Long-term rule Agent and workspace are required');
}

export function createLongTermRulesApi(): CompleteHostServiceRegistry['longTermRules'] {
  return {
    list: (payload) => {
      requireContext(payload);
      return longTermRuleService.list(payload as LongTermRuleListPayload);
    },
    create: (payload) => {
      requireContext(payload);
      if ((payload.scope !== 'global' && payload.scope !== 'agent') || typeof payload.content !== 'string') {
        throw new Error('Invalid long-term rule create payload');
      }
      return longTermRuleService.create(payload as LongTermRuleCreatePayload);
    },
    update: (payload) => {
      requireContext(payload);
      if (
        typeof payload.id !== 'string'
        || (payload.content !== undefined && typeof payload.content !== 'string')
        || (payload.enabled !== undefined && typeof payload.enabled !== 'boolean')
      ) throw new Error('Invalid long-term rule update payload');
      return longTermRuleService.update(payload as LongTermRuleUpdatePayload);
    },
    delete: (payload) => {
      requireContext(payload);
      if (typeof payload.id !== 'string') throw new Error('Invalid long-term rule delete payload');
      return longTermRuleService.delete(payload as LongTermRuleDeletePayload);
    },
    undo: (payload) => {
      requireContext(payload);
      if (typeof payload.undoToken !== 'string') throw new Error('Invalid long-term rule undo payload');
      return longTermRuleService.undo(payload as LongTermRuleUndoPayload);
    },
    capture: (payload) => {
      requireContext(payload);
      if (typeof payload.message !== 'string') throw new Error('Invalid long-term rule capture payload');
      return longTermRuleService.capture(payload as LongTermRuleCapturePayload);
    },
    repair: (payload) => {
      requireContext(payload);
      return longTermRuleService.repair(payload);
    },
  };
}
