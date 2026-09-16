// Punto de entrada que esbuild empaqueta para los tests: reexporta el código
// real de `src/odoo`, que no depende del módulo `vscode` y por tanto puede
// ejecutarse en Node puro.
export { OdooClient, OdooError, normalizeBaseUrl } from '../../src/odoo/client';
export { parseMajorVersion } from '../../src/odoo/transport';
export { detectSchema } from '../../src/odoo/schema';
export {
  searchTasks,
  listProjects,
  createTask,
  scopeDomain,
  orderClause,
  projectOf,
  stageOf,
  recordUrl,
} from '../../src/odoo/tasks';
export {
  resolveEmployeeId,
  createTimesheetLines,
  fetchTimesheetLines,
  hoursDomain,
} from '../../src/odoo/timesheets';
export { diagnoseMissingTasks } from '../../src/odoo/diagnostics';
export { formatTaskDate, daysAgo, monthOf, monthRange, eachDay, weekdayOf } from '../../src/util';
// hours.ts tampoco importa `vscode`: la agregación se prueba sin servidor.
export { summarizeMonth } from '../../src/hours';
// registry.ts no importa `vscode`: se puede empaquetar sin stub.
export { CommitRegistry, pruneRegistry, REGISTRY_KEY } from '../../src/registry';
