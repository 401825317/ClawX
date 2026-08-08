import { describe, expect, it } from 'vitest';
import { createEmptyAcpTimeline } from '@/lib/acp/reducer';
import { AcpSessionTimelineCoordinator } from '@/lib/acp/session-timeline-coordinator';

function record(sessionKey: string, generation: number) {
  return {
    sessionKey,
    generation,
    workspaceRoot: `/workspace/${sessionKey}`,
    cwd: `/workspace/${sessionKey}`,
    timeline: createEmptyAcpTimeline(sessionKey, generation),
  };
}

describe('ACP session timeline coordinator', () => {
  it('increments one session revision for replacement and timeline updates', () => {
    const coordinator = new AcpSessionTimelineCoordinator();
    const initial = coordinator.replace(record('agent:pi:s1', 1));
    const updated = coordinator.update(
      { sessionKey: 'agent:pi:s1', generation: 1 },
      (timeline) => ({ ...timeline, metadata: { ...timeline.metadata, title: 'Ready' } }),
    );

    expect(initial.revision).toBe(1);
    expect(updated).toMatchObject({ revision: 2, timeline: { metadata: { title: 'Ready' } } });
  });

  it('does not increment a revision for an idempotent update', () => {
    const coordinator = new AcpSessionTimelineCoordinator();
    const initial = coordinator.replace(record('agent:pi:s1', 1));
    const updated = coordinator.update(
      { sessionKey: 'agent:pi:s1', generation: 1 },
      (timeline) => timeline,
    );

    expect(updated).toBe(initial);
    expect(updated?.revision).toBe(1);
  });

  it('keeps inactive sessions isolated and rejects a generation mismatch', () => {
    const coordinator = new AcpSessionTimelineCoordinator();
    coordinator.replace(record('agent:pi:s1', 1));
    coordinator.replace(record('agent:pi:s2', 4));

    expect(coordinator.update(
      { sessionKey: 'agent:pi:s1', generation: 2 },
      (timeline) => ({ ...timeline, metadata: { title: 'wrong' } }),
    )).toBeUndefined();
    coordinator.update(
      { sessionKey: 'agent:pi:s1', generation: 1 },
      (timeline) => ({ ...timeline, metadata: { title: 'first' } }),
    );

    expect(coordinator.read({ sessionKey: 'agent:pi:s1', generation: 1 })?.timeline.metadata.title).toBe('first');
    expect(coordinator.read({ sessionKey: 'agent:pi:s2', generation: 4 })?.timeline.metadata.title).toBeUndefined();
  });

  it('retains a session until all owners release it', () => {
    const coordinator = new AcpSessionTimelineCoordinator({ maxUnretainedRecords: 1 });
    coordinator.replace(record('agent:pi:s1', 1));
    coordinator.retain({ sessionKey: 'agent:pi:s1', generation: 1 }, 'turn:first');
    coordinator.retain({ sessionKey: 'agent:pi:s1', generation: 1 }, 'attachment:a');
    coordinator.replace(record('agent:pi:s2', 1));
    coordinator.replace(record('agent:pi:s3', 1));

    expect(coordinator.read({ sessionKey: 'agent:pi:s1', generation: 1 })?.retained).toBe(true);
    coordinator.release({ sessionKey: 'agent:pi:s1', generation: 1 }, 'turn:first');
    expect(coordinator.read({ sessionKey: 'agent:pi:s1', generation: 1 })?.retained).toBe(true);
    coordinator.release({ sessionKey: 'agent:pi:s1', generation: 1 }, 'attachment:a');
    coordinator.replace(record('agent:pi:s4', 1));
    expect(coordinator.read({ sessionKey: 'agent:pi:s1', generation: 1 })).toBeUndefined();
  });

  it('evicts only the least-recently-used unretained records', () => {
    const coordinator = new AcpSessionTimelineCoordinator({ maxUnretainedRecords: 2 });
    coordinator.replace(record('agent:pi:s1', 1));
    coordinator.replace(record('agent:pi:s2', 1));
    coordinator.read({ sessionKey: 'agent:pi:s1', generation: 1 });
    coordinator.replace(record('agent:pi:s3', 1));

    expect(coordinator.read({ sessionKey: 'agent:pi:s1', generation: 1 })).toBeDefined();
    expect(coordinator.read({ sessionKey: 'agent:pi:s2', generation: 1 })).toBeUndefined();
    expect(coordinator.read({ sessionKey: 'agent:pi:s3', generation: 1 })).toBeDefined();
  });

  it('removes every generation belonging to one session', () => {
    const coordinator = new AcpSessionTimelineCoordinator();
    coordinator.replace(record('agent:pi:s1', 1));
    coordinator.replace(record('agent:pi:s1', 2));
    coordinator.replace(record('agent:pi:s2', 1));

    coordinator.removeSession('agent:pi:s1');

    expect(coordinator.read({ sessionKey: 'agent:pi:s1', generation: 1 })).toBeUndefined();
    expect(coordinator.read({ sessionKey: 'agent:pi:s1', generation: 2 })).toBeUndefined();
    expect(coordinator.read({ sessionKey: 'agent:pi:s2', generation: 1 })).toBeDefined();
  });
});
