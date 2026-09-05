import {
  applyPortableEnvironment,
  repairPortableLayoutBeforeBootstrap,
} from './portable-mode';

/** Apply portable environment variables before other Main-process modules evaluate. */
const layoutRepair = repairPortableLayoutBeforeBootstrap();
if (layoutRepair.repaired || layoutRepair.reason) {
  const detail = layoutRepair.actions.length > 0
    ? ` actions=${layoutRepair.actions.join(',')}`
    : '';
  const reason = layoutRepair.reason ? ` reason=${layoutRepair.reason}` : '';
  console.info(`[UClaw] Portable layout bootstrap check.${detail}${reason}`);
}
export const portableModeInfo = applyPortableEnvironment();
