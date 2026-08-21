export type PortableRuntimeHealthIssue =
  | 'snapshot-repeatedly-deferred'
  | 'snapshot-overdue'
  | 'snapshot-not-completed';

export type PortableRuntimeHealthSnapshot = {
  mode: 'portable';
  status: 'pending' | 'healthy' | 'warning';
  consecutiveFailures: number;
  lastSuccessfulAt?: string;
  issue?: PortableRuntimeHealthIssue;
};
