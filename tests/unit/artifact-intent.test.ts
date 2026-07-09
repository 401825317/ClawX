import { describe, expect, it } from 'vitest';
import { isArtifactCapabilityQuestion } from '../../shared/artifact-intent';
import { runRequiresArtifact } from '../../src/stores/chat/gate-policy';
import type { ChatRuntimeRunState } from '../../src/stores/chat/types';

function createRun(objective: string, detail = objective): ChatRuntimeRunState {
  return {
    runId: `run-${objective.length}`,
    status: 'completed',
    objective,
    events: [
      { type: 'run.started', runId: 'run-started', objective, timestamp: 1 },
    ],
    planSteps: [
      {
        id: 'uclaw.execute',
        title: '执行任务',
        detail,
        status: 'completed',
      },
    ],
    artifacts: [],
    verifications: [],
    checkpoints: [],
  };
}

describe('artifact intent helpers', () => {
  it('classifies artifact capability questions as non-delivery chat', () => {
    expect(isArtifactCapabilityQuestion('你现在能做哪些文件类产物？')).toBe(true);
    expect(isArtifactCapabilityQuestion('普通聊天：你现在能做哪些文件类产物？')).toBe(true);
    expect(isArtifactCapabilityQuestion('PPT/Excel/小程序你能做吗？')).toBe(true);
    expect(runRequiresArtifact(createRun('你现在能做哪些文件类产物？'))).toBe(false);
    expect(runRequiresArtifact(createRun('普通聊天：你现在能做哪些文件类产物？'))).toBe(false);
  });

  it('still requires artifacts for explicit delivery requests', () => {
    expect(isArtifactCapabilityQuestion('帮我做一个 PPT')).toBe(false);
    expect(runRequiresArtifact(createRun('帮我做一个 PPT'))).toBe(true);
    expect(runRequiresArtifact(createRun('生成一个 Excel 表格'))).toBe(true);
  });
});
