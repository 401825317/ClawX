import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  patchOpenClawTaskSummaryDeliveryContent,
  patchOpenClawTaskSummaryDeliveryRuntime,
} from './openclaw-task-summary-delivery-patch.mjs';

const handlerFixture = `function mapTaskSummary(task) {
\treturn {
\t\tstatus: TASK_STATUS_TO_LEDGER_STATUS[task.status],
\t\ttitle: formatTaskStatusTitle(task),
\t};
}`;

const schemaFixture = `const TaskSummarySchema = Type.Object({
\tstatus: TaskLedgerStatusSchema,
\ttitle: Type.Optional(Type.String()),
}, { additionalProperties: false });`;

const typeFixture = `/** Public task summary returned by task list/get/cancel responses. */
declare const TaskSummarySchema: Type.TObject<{
  status: Type.TUnion<[Type.TLiteral<"queued">, Type.TLiteral<"running">, Type.TLiteral<"completed">, Type.TLiteral<"failed">, Type.TLiteral<"cancelled">, Type.TLiteral<"timed_out">]>;
  title: Type.TOptional<Type.TString>;
}>;`;

const patchedHandler = patchOpenClawTaskSummaryDeliveryContent(handlerFixture, 'tasks.js');
assert.equal(patchedHandler.category, 'handler');
assert.match(patchedHandler.content, /deliveryStatus: task\.deliveryStatus/);
assert.match(patchedHandler.content, /terminalOutcome/);

const patchedSchema = patchOpenClawTaskSummaryDeliveryContent(schemaFixture, 'schema.js');
assert.equal(patchedSchema.category, 'schema');
assert.match(patchedSchema.content, /deliveryStatus: Type\.Optional/);

const patchedType = patchOpenClawTaskSummaryDeliveryContent(typeFixture, 'schema.d.ts');
assert.equal(patchedType.category, 'type');
assert.match(patchedType.content, /deliveryStatus: Type\.TOptional/);

const distDir = mkdtempSync(join(tmpdir(), 'uclaw-task-summary-'));
mkdirSync(join(distDir, 'plugin-sdk'), { recursive: true });
writeFileSync(join(distDir, 'tasks.js'), handlerFixture, 'utf8');
writeFileSync(join(distDir, 'schema.js'), schemaFixture, 'utf8');
writeFileSync(join(distDir, 'schema.d.ts'), typeFixture, 'utf8');
writeFileSync(join(distDir, 'plugin-sdk', 'tasks.d.ts'), typeFixture, 'utf8');

const first = patchOpenClawTaskSummaryDeliveryRuntime(distDir, { logger: { log() {} } });
assert.equal(first.patchedFiles, 4);
assert.equal(first.categoryCounts.handler, 1);
assert.equal(first.categoryCounts.schema, 1);
assert.equal(first.categoryCounts.type, 2);
assert.match(readFileSync(join(distDir, 'tasks.js'), 'utf8'), /UCLAW_TASK_SUMMARY_DELIVERY_HANDLER/);

const second = patchOpenClawTaskSummaryDeliveryRuntime(distDir, { logger: { log() {} } });
assert.equal(second.patchedFiles, 0);
assert.equal(second.alreadyPatchedFiles, 4);

console.log('openclaw task summary delivery patch tests passed');
