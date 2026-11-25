import { ContextMenu, Tooltip } from '@emdash/ui/react/primitives';
import { CircleCheck, Crown, Layers, Unlink } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getInitiativesClient } from '@core/features/initiatives/api/browser/client';
import {
  type TaskDependencyView,
  taskDependencyView,
} from '@core/features/initiatives/api/browser/dependency-view';
import { getInitiativesStore } from '@core/features/initiatives/api/browser/initiatives-store';
import { getProjectStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import {
  getTaskGitCheckoutStore,
  getTaskPrAssociationStore,
} from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import { type TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import {
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { TaskContextMenu } from '@core/features/tasks/contributions/browser/task-context-menu';
import { TaskGitDiffStats } from '@core/features/tasks/contributions/browser/task-git-diff-stats';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskWorkspace } from '@core/features/workbench/api/browser/task-composition-selectors';
import { TaskSidebarTrailingSlot } from '@core/features/workbench/browser/sidebar/task-sidebar-agent-status';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import {
  useNavigate,
  useViewParams,
  useWorkspaceSlots,
} from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import { registeredTaskData } from '@core/primitives/task-state/browser/task-state';
import { selectCurrentPr } from '@root/src/core/services/pull-requests/api';
import { PrBadge } from '@root/src/core/services/pull-requests/browser/components/pr-badge';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';
import { SidebarTaskAgentLogos } from './task-agent-logos';

interface SidebarTaskItemProps {
  taskId: string;
  projectId: string;
  /**
   * Pinned strip uses tighter padding than tasks nested under a project; the ungrouped list
   * also uses it and labels each task with its project.
   */
  /** `flat` and `underInitiative` rows show the task's project, as the list mixes projects. */
  rowVariant?: 'underProject' | 'pinned' | 'flat' | 'underInitiative';
}

export const SidebarTaskItem = observer(function SidebarTaskItem({
  taskId,
  projectId,
  rowVariant = 'underProject',
}: SidebarTaskItemProps) {
  const { navigate } = useNavigate();
  const openRename = useOpenModal('renameTaskModal');
  const openDeleteTask = useOpenModal('deleteTaskModal');
  const openInitiativePicker = useOpenModal('initiativePickerModal');

  const { currentView } = useWorkspaceSlots();
  const params = useViewParams(taskViewDef);
  const { value: interfaceSettings } = useAppSettingsKey('interface');
  const isActive =
    currentView === 'task' && params?.taskId === taskId && params.projectId === projectId;

  const task = getTaskStore(projectId, taskId)!;
  const taskManager = getTaskManagerStore(projectId);

  const taskName = task.data.name;

  const openTask = () => {
    navigate(taskViewDef({ projectId, taskId }));
  };

  const handleArchive = () => {
    if (isActive) navigate(projectViewDef({ projectId }));
    void taskManager?.archiveTask(taskId);
  };

  const handleRename = () => {
    void openRename({ projectId, taskId, currentName: taskName });
  };

  const handleDelete = () => {
    void openDeleteTask({
      projectId,
      tasks: [{ taskId, taskName }],
    }).then((outcome) => {
      if (!outcome.success) return;
      const { deleteWorktree, deleteBranch, deleteConversations } = outcome.data;
      void taskManager?.deleteTasks([taskId], {
        deleteWorktree,
        deleteBranch,
        deleteConversations,
      });
      if (isActive) navigate(projectViewDef({ projectId }));
    });
  };

  const canPin = task.state !== 'unregistered';
  const initiativeId = registeredTaskData(task)?.initiativeId ?? null;
  const initiative = initiativeId ? getInitiativesStore().byId.get(initiativeId) : undefined;
  const isLead = initiative?.leadTaskId === taskId;
  const dependencies = initiative ? taskDependencyView(initiative, taskId) : undefined;
  const isMarkedDone = registeredTaskData(task)?.status === 'done';

  const workspaceStore = getTaskWorkspace(projectId, taskId);
  const git = getTaskGitCheckoutStore(projectId, taskId);
  const showLineChanges = interfaceSettings?.showLeftSidebarLineChanges ?? false;
  const showPrStatus = interfaceSettings?.showLeftSidebarPrStatus ?? true;
  const showTimestamps = interfaceSettings?.showLeftSidebarTimestamps ?? true;
  const branchName = git?.branchName ?? undefined;
  const handleReconnect =
    workspaceStore?.connectionState != null ? () => workspaceStore.reconnect() : undefined;

  return (
    <TaskContextMenu
      isPinned={task.data.isPinned}
      canPin={canPin}
      isArchived={false}
      branchName={branchName}
      onPin={() => void task.setPinned(true)}
      onUnpin={() => void task.setPinned(false)}
      onRename={handleRename}
      onArchive={handleArchive}
      onReconnect={handleReconnect}
      onConvertAutomation={undefined}
      onDelete={handleDelete}
      extraItems={
        <>
          {initiative && !isLead && (
            <ContextMenu.Item
              onClick={() =>
                void getInitiativesClient().then((client) =>
                  client.setLead({ initiativeId: initiative.id, taskId })
                )
              }
            >
              <Crown className="size-4" />
              Make initiative lead
            </ContextMenu.Item>
          )}
          {initiative && (
            <ContextMenu.Item
              onClick={() => void task.updateStatus(isMarkedDone ? 'in_progress' : 'done')}
            >
              <CircleCheck className="size-4" />
              {isMarkedDone ? 'Mark not done' : 'Mark done'}
            </ContextMenu.Item>
          )}
          {dependencies && dependencies.dependsOn.length > 0 && (
            <ContextMenu.Item
              onClick={() =>
                void getInitiativesClient().then((client) =>
                  client.setDependencies({ taskId, dependsOnTaskIds: [] })
                )
              }
            >
              <Unlink className="size-4" />
              Remove dependencies
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            onClick={() =>
              void openInitiativePicker({
                taskIds: [taskId],
                currentInitiativeId: registeredTaskData(task)?.initiativeId,
              })
            }
          >
            <Layers className="size-4" />
            Initiative…
          </ContextMenu.Item>
        </>
      }
    >
      <SidebarMenuRow
        className={cn(
          'group/row flex items-center justify-between px-1 py-1.5 h-8 gap-1',
          rowVariant === 'underProject'
            ? 'pl-8'
            : rowVariant === 'underInitiative'
              ? 'pl-6'
              : 'pl-2'
        )}
        isActive={isActive}
        onMouseDown={(e) => e.preventDefault()}
        onClick={openTask}
      >
        <SidebarMenuAction
          aria-label={`Open task ${taskName || 'task'}`}
          className="gap-1 overflow-hidden"
        >
          {isLead && rowVariant === 'underInitiative' && (
            <Crown
              aria-label="Initiative lead"
              className="size-3.5 shrink-0 text-foreground-tertiary-passive"
            />
          )}
          {dependencies && rowVariant === 'underInitiative' && (
            <DependencyRank view={dependencies} />
          )}
          <SidebarTaskAgentLogos task={task} />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-left transition-colors',
              task.isBootstrapping && 'text-foreground/40'
            )}
          >
            {taskName}
          </span>
          {/* Right-aligned and kept whole: the name truncates first. */}
          {(rowVariant === 'flat' || rowVariant === 'underInitiative') && (
            <span className="max-w-[45%] shrink-0 truncate text-right text-xs text-foreground-tertiary-passive">
              {getProjectStore(projectId)?.name}
            </span>
          )}
        </SidebarMenuAction>
        <div className="ml-2 flex shrink-0 items-center justify-end gap-1.5">
          {showLineChanges && <TaskGitDiffStats task={task} />}
          {showPrStatus && <RenderPrBadge task={task} />}
          <TaskSidebarTrailingSlot task={task} showTimestamp={showTimestamps} />
        </div>
      </SidebarMenuRow>
    </TaskContextMenu>
  );
});

const RenderPrBadge = observer(function RenderPrBadge({ task }: { task: TaskStore }) {
  const pr = selectCurrentPr(getTaskPrAssociationStore(task).pullRequests);
  return pr ? (
    <span onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <PrBadge variant="compact" pr={pr} hoverDelay={100} />
    </span>
  ) : null;
});

/** The task's place in its initiative's landing order, with what it waits on on hover. */
function DependencyRank({ view }: { view: TaskDependencyView }) {
  const waiting = view.dependsOn.filter((dependency) => !dependency.looksDone);
  const done = view.dependsOn.filter((dependency) => dependency.looksDone);
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span
            aria-label={view.rank ? `Lands ${view.rank}` : 'In a dependency cycle'}
            className={cn(
              'flex h-4 min-w-4 shrink-0 items-center justify-center rounded px-1 text-[10px] tabular-nums',
              view.rank
                ? waiting.length > 0
                  ? 'bg-background-2 text-foreground-tertiary-passive'
                  : 'bg-background-2 text-foreground-secondary'
                : 'bg-background-2 text-foreground-destructive'
            )}
          >
            {view.rank ?? '!'}
          </span>
        }
      />
      <Tooltip.Content>
        <div className="flex flex-col gap-0.5 text-xs">
          <span>
            {view.inCycle
              ? 'In a dependency cycle'
              : view.rank
                ? `Lands in step ${view.rank}`
                : 'Waits on a dependency cycle'}
          </span>
          {waiting.length > 0 && (
            <span>Waiting on {waiting.map((dependency) => dependency.name).join(', ')}</span>
          )}
          {done.map((dependency) => (
            <span key={dependency.taskId}>
              {dependency.name} looks done ({dependency.looksDone})
            </span>
          ))}
        </div>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
