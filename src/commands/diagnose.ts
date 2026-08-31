import * as vscode from 'vscode';
import { diagnoseMissingTasks, type DiagnosticsReport } from '../odoo/diagnostics';
import type { TaskOrder, TaskScope } from '../odoo/tasks';
import type { OdooSession } from '../state';
import { formatHours, truncate } from '../util';

/**
 * «Odoo: Diagnosticar tareas que faltan» — para no tener que investigar a mano
 * por qué una tarea con horas imputadas no sale en el panel.
 */
export async function diagnoseTasksCommand(
  session: OdooSession,
  log: vscode.LogOutputChannel,
): Promise<void> {
  if (!session.isConnected) {
    const action = await vscode.window.showWarningMessage(
      'Conéctate a Odoo para diagnosticar las tareas.',
      'Conectar a Odoo',
    );
    if (action === 'Conectar a Odoo') {
      await vscode.commands.executeCommand('odooTimesheet.connect');
    }
    return;
  }

  const { client, schema } = session.requireConnection();
  const config = vscode.workspace.getConfiguration('odooTimesheet');

  try {
    const report = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Revisando tus tareas en Odoo…' },
      () =>
        diagnoseMissingTasks(client, schema, {
          scope: config.get<TaskScope>('taskScope', 'mine'),
          order: config.get<TaskOrder>('taskOrder', 'created'),
          daysBack: config.get<number>('diagnosticsDays', 60),
          tasksPerProject: config.get<number>('tasksPerProject', 10),
        }),
    );

    log.info(render(report));
    log.show();

    const hidden = report.tasks.filter((task) => !task.visible).length;
    if (report.tasks.length === 0) {
      void vscode.window.showInformationMessage(
        `Sin imputaciones tuyas con tarea desde ${report.since}.`,
      );
    } else if (hidden === 0) {
      void vscode.window.showInformationMessage(
        `Las ${report.tasks.length} tareas con horas tuyas son visibles en el panel.`,
      );
    } else {
      void vscode.window.showWarningMessage(
        `${hidden} de ${report.tasks.length} tareas con horas tuyas no aparecen en el panel. El motivo está en el registro.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Diagnóstico fallido: ${message}`);
    void vscode.window.showErrorMessage(message, 'Ver registro').then((action) => {
      if (action) {
        log.show();
      }
    });
  }
}

function render(report: DiagnosticsReport): string {
  const lines: string[] = [
    'Diagnóstico de tareas que no aparecen en el panel',
    `  Desde            ${report.since} (${report.daysBack} días)`,
    `  Líneas de horas  ${report.linesFound}`,
    `  taskScope        ${report.scope}`,
    `  taskOrder        ${report.order}`,
    `  tasksPerProject  ${report.tasksPerProject}`,
    '',
  ];

  if (report.tasks.length === 0) {
    lines.push('  No se encontraron imputaciones tuyas con tarea en ese periodo.');
  }

  for (const task of report.tasks) {
    const mark = task.visible ? '✓' : '✗';
    lines.push(
      `  ${mark} #${task.taskId} ${truncate(task.taskName, 70)}`,
      `      proyecto: ${task.projectName ?? 'ninguno'} · ${formatHours(task.loggedHours)} · última imputación ${task.lastDate}`,
    );
    for (const reason of task.reasons) {
      lines.push(`      → ${reason}`);
    }
  }

  if (report.suggestions.length > 0) {
    lines.push('', '  Qué hacer:');
    for (const suggestion of report.suggestions) {
      lines.push(`   • ${suggestion}`);
    }
  }

  return lines.join('\n');
}
