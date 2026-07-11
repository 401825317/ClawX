import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getOpenClawConfigDir } from '../../utils/paths';
import type { BlenderJobSnapshot } from './types';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export class BlenderJobStore {
  readonly rootDir: string;

  constructor(rootDir = path.join(getOpenClawConfigDir(), 'uclaw-runtime', 'blender-jobs')) {
    this.rootDir = rootDir;
  }

  jobDir(jobId: string): string {
    return path.join(this.rootDir, 'jobs', jobId);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.join(this.rootDir, 'jobs'), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }

  async createJobDir(jobId: string): Promise<string> {
    const directory = this.jobDir(jobId);
    await fs.mkdir(directory, { recursive: false, mode: PRIVATE_DIRECTORY_MODE });
    await Promise.all([
      fs.mkdir(path.join(directory, 'assets'), { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
      fs.mkdir(path.join(directory, 'outputs'), { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
    ]);
    return directory;
  }

  async save(snapshot: BlenderJobSnapshot): Promise<void> {
    const target = path.join(snapshot.jobDir, 'job.json');
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    await fs.rename(temporary, target);
  }

  async appendJournal(snapshot: BlenderJobSnapshot, type: string, data: Record<string, unknown> = {}): Promise<void> {
    const journalEntry = {
      version: 1,
      ts: Date.now(),
      jobId: snapshot.jobId,
      revision: snapshot.revision,
      type,
      data,
    };
    await fs.appendFile(path.join(snapshot.jobDir, 'journal.jsonl'), `${JSON.stringify(journalEntry)}\n`, { mode: PRIVATE_FILE_MODE });
  }

  async read(jobId: string): Promise<BlenderJobSnapshot | undefined> {
    try {
      const raw = await fs.readFile(path.join(this.jobDir(jobId), 'job.json'), 'utf8');
      return JSON.parse(raw) as BlenderJobSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(): Promise<BlenderJobSnapshot[]> {
    await this.initialize();
    const entries = await fs.readdir(path.join(this.rootDir, 'jobs'), { withFileTypes: true });
    const snapshots = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.read(entry.name)));
    return snapshots.filter((snapshot): snapshot is BlenderJobSnapshot => Boolean(snapshot));
  }
}
