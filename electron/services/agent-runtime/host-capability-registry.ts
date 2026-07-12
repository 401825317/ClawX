import type { ChatRuntimeArtifact, ChatRuntimeVerification } from '../../../shared/chat-runtime-events';
import type {
  HostTaskExecutorContext,
  HostTaskLifecycleExecutor,
} from './host-task-service';

export type HostCapabilityAvailability = 'available' | 'unavailable' | 'not_implemented';

export type HostCapabilityDescriptor = {
  kind: string;
  label: string;
  description: string;
  sideEffect: 'none' | 'local_artifact' | 'remote_generation' | 'external_action';
  requiresApproval: boolean;
  availability?: HostCapabilityAvailability;
  reason?: string;
  inputSchema?: Record<string, unknown>;
  outputDescription?: string;
};

export type ResolvedHostCapability = HostCapabilityDescriptor & {
  availability: HostCapabilityAvailability;
  operations: {
    start: true;
    cancel: boolean;
    resume: boolean;
  };
};

export type HostCapabilityTaskContext = HostTaskExecutorContext;

export type HostCapabilityExecutor = HostTaskLifecycleExecutor & {
  descriptor: HostCapabilityDescriptor;
  assess?: () => Promise<Pick<ResolvedHostCapability, 'availability' | 'reason'>>;
};

export class HostCapabilityRegistry {
  private readonly executors = new Map<string, HostCapabilityExecutor>();

  register(executor: HostCapabilityExecutor): void {
    const kind = executor.descriptor.kind.trim();
    if (!/^[a-zA-Z0-9._-]{1,240}$/u.test(kind)) throw new Error('Invalid Host capability kind');
    if (this.executors.has(kind)) throw new Error(`Host capability ${kind} is already registered`);
    this.executors.set(kind, { ...executor, descriptor: { ...executor.descriptor, kind } });
  }

  has(kind: string): boolean {
    return this.executors.has(kind.trim());
  }

  async list(): Promise<ResolvedHostCapability[]> {
    return await Promise.all([...this.executors.values()].map(async (executor) => await this.resolve(executor)));
  }

  async get(kind: string): Promise<{ executor: HostCapabilityExecutor; capability: ResolvedHostCapability } | undefined> {
    const executor = this.executors.get(kind.trim());
    if (!executor) return undefined;
    return { executor, capability: await this.resolve(executor) };
  }

  private async resolve(executor: HostCapabilityExecutor): Promise<ResolvedHostCapability> {
    const baseline: ResolvedHostCapability = {
      ...executor.descriptor,
      availability: executor.descriptor.availability ?? 'available',
      operations: {
        start: true,
        cancel: typeof executor.cancel === 'function',
        resume: typeof executor.resume === 'function',
      },
    };
    if (!executor.assess) return baseline;
    try {
      const assessed = await executor.assess();
      return { ...baseline, ...assessed };
    } catch (error) {
      return {
        ...baseline,
        availability: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export type HostCapabilityTaskOutput = {
  artifacts: ChatRuntimeArtifact[];
  verifications: ChatRuntimeVerification[];
};

export const hostCapabilityRegistry = new HostCapabilityRegistry();
