import { AgentStatus } from '@emdash/ui/react/components';
import { Toaster, toast } from '@emdash/ui/react/primitives';
import {
  Archive,
  ChevronLeft,
  GitMerge,
  GitPullRequest,
  Layers,
  Monitor,
  MoreHorizontal,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { taskAgentStatus } from '@core/features/conversations/api/browser/conversation-selectors';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { ConversationChat } from '@core/features/conversations/contributions/browser/conversation-chat';
import { getInitiativesStore } from '@core/features/initiatives/api/browser/initiatives-store';
import {
  asAvailableProject,
  getProjectManagerStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { getRemoteControlClient } from '@core/features/remote-control/api/browser/client';
import { getTaskPrAssociationStore } from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import type { TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import {
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { homeViewDef } from '@core/features/workbench/contributions/views';
import type { AgentStatus as AgentStatusValue } from '@core/primitives/agents/api';
import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { cn } from '@core/primitives/styling/browser/cn';
import { registeredTaskData } from '@core/primitives/task-state/browser/task-state';
import { selectCurrentPr } from '@core/services/pull-requests/api';
import { mobileTaskSections, shortAgo, type MobileTaskEntry } from './mobile-sections';
import { useDesktopViewSwitch } from './use-mobile-layout';

/**
 * The app on a phone (remote control): one screen at a time — the workspace list, a
 * workspace's chat, or a new workspace — driven by the same navigation as the desktop layout,
 * so notification taps and links open the right workspace.
 */
export const MobileWorkspace = observer(function MobileWorkspace() {
  const navigation = getNavigation();
  const [creating, setCreating] = useState(false);
  const current = navigation.currentRef;
  const task =
    current.viewId === taskViewDef.id
      ? (current.params as { projectId: string; taskId: string })
      : null;

  return (
    <div
      className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground"
      style={
        {
          paddingTop: 'env(safe-area-inset-top)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
          // Messages use the whole width on a phone.
          '--em-chat-content-width': 'none',
        } as CSSProperties
      }
    >
      {creating ? (
        <NewWorkspaceScreen onClose={() => setCreating(false)} />
      ) : task ? (
        <TaskScreen projectId={task.projectId} taskId={task.taskId} />
      ) : (
        <TaskListScreen onCreate={() => setCreating(true)} />
      )}
      <Toaster />
    </div>
  );
});

// ── Workspace list ─────────────────────────────────────────────────────────────

const RECENT_PAGE = 30;

function visibleTasks(): MobileTaskEntry[] {
  const initiatives = getInitiativesStore().byId;
  const entries: MobileTaskEntry[] = [];
  for (const project of getProjectManagerStore().projects.values()) {
    if (!asAvailableProject(project)) continue;
    for (const task of getTaskManagerStore(project.id)?.tasks.values() ?? []) {
      const data = registeredTaskData(task);
      if (task.data.type === 'automation-run' || (data && data.archivedAt)) continue;
      const pr = data ? selectCurrentPr(getTaskPrAssociationStore(task).pullRequests) : undefined;
      entries.push({
        projectId: project.id,
        projectName: project.name ?? 'Project',
        taskId: task.data.id,
        name: task.data.name,
        status: taskAgentStatus(task),
        activityAt: data ? (data.lastInteractedAt ?? data.updatedAt) : undefined,
        initiativeName: data?.initiativeId
          ? (initiatives.get(data.initiativeId)?.name ?? null)
          : null,
        pullRequest: pr ? (pr.isDraft && pr.status === 'open' ? 'draft' : pr.status) : null,
      });
    }
  }
  return entries;
}

const TaskListScreen = observer(function TaskListScreen({ onCreate }: { onCreate: () => void }) {
  const [query, setQuery] = useState('');
  const [recentShown, setRecentShown] = useState(RECENT_PAGE);
  const [menuOpen, setMenuOpen] = useState(false);
  const switchToDesktop = useDesktopViewSwitch();
  const sections = mobileTaskSections(visibleTasks(), query);
  const now = useMinuteClock();
  const summary = [
    sections.attention.length > 0 ? `${sections.attention.length} need you` : null,
    sections.working.length > 0 ? `${sections.working.length} working` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const empty = sections.attention.length + sections.working.length + sections.recent.length === 0;

  return (
    <>
      <header className="shrink-0 px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-[26px] leading-tight font-semibold tracking-tight">Workspaces</h1>
            <p className="h-5 text-sm text-foreground-muted">{summary || PRODUCT_NAME}</p>
          </div>
          <IconButton label="More" onClick={() => setMenuOpen(true)}>
            <MoreHorizontal className="size-5" />
          </IconButton>
          <button
            type="button"
            aria-label="New workspace"
            onClick={onCreate}
            className="flex size-10 items-center justify-center rounded-full bg-foreground text-background shadow-sm active:scale-95"
          >
            <Plus className="size-5" />
          </button>
        </div>
        <label className="mt-3 flex h-10 items-center gap-2 rounded-xl bg-background-1 px-3 text-foreground-muted">
          <Search className="size-4 shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search workspaces"
            className="min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-foreground-passive"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
              <X className="size-4" />
            </button>
          )}
        </label>
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
      >
        {empty && (
          <p className="px-6 pt-16 text-center text-sm text-foreground-muted">
            {query ? 'No workspaces match.' : 'No workspaces yet. Start one with +.'}
          </p>
        )}
        <TaskSection title="Needs you" entries={sections.attention} now={now} />
        <TaskSection title="Working" entries={sections.working} now={now} />
        <TaskSection title="Recent" entries={sections.recent.slice(0, recentShown)} now={now} />
        {sections.recent.length > recentShown && (
          <button
            type="button"
            onClick={() => setRecentShown((shown) => shown + RECENT_PAGE)}
            className="mx-4 mt-1 w-[calc(100%-2rem)] rounded-xl py-3 text-sm text-foreground-muted active:bg-background-1"
          >
            Show {Math.min(RECENT_PAGE, sections.recent.length - recentShown)} more
          </button>
        )}
      </div>
      <ActionSheet open={menuOpen} onClose={() => setMenuOpen(false)}>
        <SheetAction icon={<Monitor className="size-5" />} onClick={switchToDesktop}>
          Desktop view
        </SheetAction>
      </ActionSheet>
    </>
  );
});

function TaskSection({
  title,
  entries,
  now,
}: {
  title: string;
  entries: MobileTaskEntry[];
  now: number;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="mt-3">
      <h2 className="px-4 pb-1 text-xs font-semibold tracking-wide text-foreground-passive uppercase">
        {title}
      </h2>
      <ul>
        {entries.map((entry) => (
          <li key={entry.taskId}>
            <TaskRow entry={entry} now={now} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATUS_LABELS: Partial<Record<AgentStatusValue, { label: string; className: string }>> = {
  'awaiting-input': {
    label: 'Needs you',
    className: 'bg-background-warning text-foreground-warning',
  },
  error: { label: 'Failed', className: 'bg-background-destructive text-foreground-destructive' },
  completed: { label: 'Done', className: 'bg-background-2 text-foreground' },
  working: { label: 'Working', className: 'bg-background-2 text-foreground-muted' },
  background: { label: 'Background', className: 'bg-background-2 text-foreground-passive' },
};

function TaskRow({ entry, now }: { entry: MobileTaskEntry; now: number }) {
  const status = entry.status ? STATUS_LABELS[entry.status] : undefined;
  return (
    <button
      type="button"
      onClick={() =>
        getNavigation().navigate(taskViewDef({ projectId: entry.projectId, taskId: entry.taskId }))
      }
      className="flex w-full items-start gap-3 px-4 py-3 text-left active:bg-background-1"
    >
      <span className="mt-1 flex size-4 shrink-0 items-center justify-center">
        {entry.status && entry.status !== 'idle' ? (
          <AgentStatus status={entry.status} />
        ) : (
          <span className="size-2 rounded-full bg-foreground-passive opacity-40" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[15px] leading-snug font-medium">{entry.name}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] text-foreground-muted">
          <span className="truncate">{entry.projectName}</span>
          {entry.initiativeName && (
            <>
              <span aria-hidden>·</span>
              <Layers className="size-3 shrink-0" />
              <span className="truncate">{entry.initiativeName}</span>
            </>
          )}
          {entry.pullRequest && <PrMark state={entry.pullRequest} />}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-xs text-foreground-passive">{shortAgo(entry.activityAt, now)}</span>
        {status && (
          <span
            className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', status.className)}
          >
            {status.label}
          </span>
        )}
      </span>
    </button>
  );
}

function PrMark({ state }: { state: NonNullable<MobileTaskEntry['pullRequest']> }) {
  const merged = state === 'merged';
  const Icon = merged ? GitMerge : GitPullRequest;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-0.5',
        merged ? 'text-foreground-info' : state === 'closed' ? 'text-foreground-passive' : ''
      )}
    >
      <span aria-hidden>·</span>
      <Icon className="size-3" />
      <span>
        {state === 'draft' ? 'Draft' : merged ? 'Merged' : state === 'closed' ? 'Closed' : 'PR'}
      </span>
    </span>
  );
}

// ── Workspace chat ─────────────────────────────────────────────────────────────

const TaskScreen = observer(function TaskScreen({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const task = getTaskStore(projectId, taskId);
  const project = getProjectManagerStore().projects.get(projectId);
  const conversations = [...(conversationRegistry.get(taskId)?.conversations.values() ?? [])]
    .filter((conversation) => conversation.data.type === 'acp')
    .sort(
      (a, b) =>
        Number(b.data.isInitialConversation === true) -
          Number(a.data.isInitialConversation === true) ||
        (b.data.lastInteractedAt ?? '').localeCompare(a.data.lastInteractedAt ?? '')
    );
  const [selected, setSelected] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const conversation =
    conversations.find((candidate) => candidate.data.id === selected) ?? conversations[0];
  const status = task ? taskAgentStatus(task) : null;
  const goBack = () => getNavigation().navigate(homeViewDef({}));

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-1">
        <IconButton label="Back" onClick={goBack}>
          <ChevronLeft className="size-6" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-tight font-semibold">
            {task?.data.name ?? 'Workspace'}
          </p>
          <p className="flex items-center gap-1.5 truncate text-xs text-foreground-muted">
            {status && status !== 'idle' && <AgentStatus status={status} />}
            <span className="truncate">{project?.name}</span>
          </p>
        </div>
        {task && (
          <IconButton label="Workspace actions" onClick={() => setMenuOpen(true)}>
            <MoreHorizontal className="size-5" />
          </IconButton>
        )}
      </header>
      {conversations.length > 1 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-border px-3 py-2">
          {conversations.map((candidate) => (
            <button
              key={candidate.data.id}
              type="button"
              onClick={() => setSelected(candidate.data.id)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[13px]',
                candidate === conversation
                  ? 'bg-foreground text-background'
                  : 'bg-background-1 text-foreground-muted'
              )}
            >
              {candidate.indicatorStatus && <AgentStatus status={candidate.indicatorStatus} />}
              <span className="max-w-40 truncate">{candidate.data.title || 'Chat'}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className="relative min-h-0 flex-1"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {!task ? (
          <Centered>Loading workspace…</Centered>
        ) : conversation ? (
          <ConversationChat
            projectId={projectId}
            taskId={taskId}
            conversationId={conversation.data.id}
          />
        ) : (
          <Centered>
            This workspace has no chat to show here. Terminal conversations are only available in
            the desktop view.
          </Centered>
        )}
      </div>
      <ActionSheet open={menuOpen} onClose={() => setMenuOpen(false)}>
        <SheetAction
          icon={<Archive className="size-5" />}
          onClick={() => {
            setMenuOpen(false);
            void getTaskManagerStore(projectId)?.archiveTask(taskId);
            goBack();
          }}
        >
          Archive workspace
        </SheetAction>
      </ActionSheet>
    </>
  );
});

// ── New workspace ──────────────────────────────────────────────────────────────

const NewWorkspaceScreen = observer(function NewWorkspaceScreen({
  onClose,
}: {
  onClose: () => void;
}) {
  const projects = [...getProjectManagerStore().projects.values()]
    .filter((project) => asAvailableProject(project))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const lastProject = useMemo(() => mostRecentProjectId(), []);
  const [projectId, setProjectId] = useState<string | null>(lastProject);
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const canCreate = !!projectId && prompt.trim().length > 0 && !submitting;

  const create = async () => {
    if (!projectId || !canCreate) return;
    setSubmitting(true);
    try {
      const created = await (
        await getRemoteControlClient()
      ).createWorkspace({
        projectId,
        prompt: prompt.trim(),
      });
      onClose();
      getNavigation().navigate(taskViewDef({ projectId, taskId: created.id }));
    } catch (error) {
      toast.error('Could not start the workspace', {
        description: error instanceof Error ? error.message : String(error),
      });
      setSubmitting(false);
    }
  };

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <button type="button" onClick={onClose} className="px-1 text-[15px] text-foreground-muted">
          Cancel
        </button>
        <p className="flex-1 text-center text-[15px] font-semibold">New workspace</p>
        <button
          type="button"
          disabled={!canCreate}
          onClick={() => void create()}
          className="rounded-full bg-foreground px-3 py-1 text-[15px] font-medium text-background disabled:opacity-40"
        >
          {submitting ? 'Starting…' : 'Start'}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="What should the agent work on?"
          rows={6}
          autoFocus
          className="w-full resize-none rounded-xl bg-background-1 p-3 text-[16px] leading-relaxed outline-none placeholder:text-foreground-passive"
        />
        <h2 className="mt-5 pb-2 text-xs font-semibold tracking-wide text-foreground-passive uppercase">
          Project
        </h2>
        <ul className="overflow-hidden rounded-xl bg-background-1">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                onClick={() => setProjectId(project.id)}
                className="flex w-full items-center gap-3 px-3 py-3 text-left text-[15px] active:bg-background-2"
              >
                <span
                  className={cn(
                    'size-4 shrink-0 rounded-full border-2',
                    project.id === projectId
                      ? 'border-foreground bg-foreground'
                      : 'border-foreground-passive'
                  )}
                />
                <span className="truncate">{project.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
});

/** The project of the most recently active workspace, as the likely next one. */
function mostRecentProjectId(): string | null {
  let best: { projectId: string; at: string } | null = null;
  for (const project of getProjectManagerStore().projects.values()) {
    for (const task of getTaskManagerStore(project.id)?.tasks.values() ?? []) {
      const data = registeredTaskData(task as TaskStore);
      const at = data ? (data.lastInteractedAt ?? data.updatedAt) : undefined;
      if (at && (!best || at > best.at)) best = { projectId: project.id, at };
    }
  }
  return best?.projectId ?? null;
}

// ── Pieces ─────────────────────────────────────────────────────────────────────

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-10 shrink-0 items-center justify-center rounded-full text-foreground active:bg-background-1"
    >
      {children}
    </button>
  );
}

function ActionSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onClick={onClose}>
      <div
        className="mx-2 mb-2 overflow-hidden rounded-2xl bg-background shadow-xl"
        style={{ marginBottom: 'calc(env(safe-area-inset-bottom) + 8px)' }}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
        <button
          type="button"
          onClick={onClose}
          className="w-full border-t border-border py-3.5 text-[15px] font-medium active:bg-background-1"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SheetAction({
  icon,
  onClick,
  children,
}: {
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-[15px] active:bg-background-1"
    >
      {icon}
      {children}
    </button>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-8 text-center text-sm text-foreground-muted">
      {children}
    </div>
  );
}

/** Re-renders every minute so "5m ago" stays current. */
function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
