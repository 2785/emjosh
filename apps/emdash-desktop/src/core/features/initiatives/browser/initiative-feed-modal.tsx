import { Button, Dialog, Switch, Textarea, toast } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { getInitiativesClient } from '@core/features/initiatives/api/browser/client';
import { getInitiativesStore } from '@core/features/initiatives/api/browser/initiatives-store';
import { isInitiativeEvent, type InitiativeMessage } from '@core/features/initiatives/api/contract';
import { splitWorkspaceLinks } from '@core/features/initiatives/api/labels';
import { InitiativeLabel } from '@core/features/initiatives/contributions/browser/initiative-label';
import { openWorkspaceLink } from '@core/features/workspace-control/api/browser/open-workspace';
import { useModalController, useOpenModal } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import { cn } from '@core/primitives/styling/browser/cn';
import { findTask } from './task-lookup';

export type InitiativeFeedModalArgs = { initiativeId: string };

function sender(message: InitiativeMessage): string {
  if (!message.fromTaskId) return isInitiativeEvent(message.kind) ? 'Emjosh' : 'You';
  return findTask(message.fromTaskId)?.name ?? 'A workspace';
}

/** The initiative's message feed: what its workspaces told each other, plus app events. */
export const InitiativeFeedModal = observer(function InitiativeFeedModal({
  initiativeId,
}: InitiativeFeedModalArgs) {
  const controller = useModalController('initiativeFeedModal');
  const initiative = getInitiativesStore().byId.get(initiativeId);
  const labels = initiative?.labels ?? {};
  const openModal = useOpenModal('confirmActionModal');
  const openLinkedWorkspace = (workspaceId: string) => {
    void openWorkspaceLink(workspaceId, async (name) => {
      const outcome = await openModal({
        title: 'Unarchive workspace',
        description: `"${name}" is archived. Unarchive it and open it?`,
        confirmLabel: 'Unarchive and open',
      });
      return outcome.success;
    })
      .then((result) => {
        if (result === 'not-found') toast.error('That workspace no longer exists');
        if (result === 'opened') controller.dismiss();
      })
      .catch((error: unknown) =>
        toast.error('Could not open the workspace', { description: String(error) })
      );
  };
  const [messages, setMessages] = useState<InitiativeMessage[]>([]);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      const client = await getInitiativesClient();
      const initial = await client.messages({ initiativeId });
      if (disposed) return;
      setMessages(initial);
      unsubscribe = await client.events.subscribe(undefined, {
        onEvent: (change) => {
          if (change.type === 'message-posted' && change.message.initiativeId === initiativeId) {
            setMessages((current) => [...current, change.message]);
          }
        },
        onGap: () => void client.messages({ initiativeId }).then(setMessages),
      });
      if (disposed) unsubscribe();
    })();
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [initiativeId]);

  useEffect(() => bottomRef.current?.scrollIntoView({ block: 'end' }), [messages.length]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    try {
      await (await getInitiativesClient()).post({ initiativeId, body });
    } catch (error) {
      setDraft(body);
      toast.error('Message not sent', { description: String(error) });
    }
  };

  const setPush = (pushMessages: boolean) =>
    void getInitiativesClient().then((client) => client.update({ id: initiativeId, pushMessages }));

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>{initiative?.name ?? 'Initiative'}</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body className="flex flex-col gap-3 pt-0 text-sm">
        <label className="flex items-center justify-between gap-3 text-foreground-muted">
          <span>
            Deliver messages into each workspace&apos;s chat (otherwise agents read them when they
            choose)
          </span>
          <Switch checked={initiative?.pushMessages ?? false} onCheckedChange={setPush} />
        </label>
        <div className="flex max-h-96 min-h-40 flex-col gap-2 overflow-y-auto rounded-md border border-border p-3">
          {messages.length === 0 && (
            <p className="text-foreground-passive">
              No messages yet. Agents in this initiative post here with post_message.
            </p>
          )}
          {messages.map((message) => (
            <div key={message.id} className="flex flex-col gap-0.5">
              <div className="flex items-baseline gap-2 text-xs text-foreground-passive">
                <span className="flex items-baseline gap-1 font-medium text-foreground-muted">
                  {message.fromTaskId && labels[message.fromTaskId] && (
                    <InitiativeLabel label={labels[message.fromTaskId]!} className="self-center" />
                  )}
                  {sender(message)}
                </span>
                {message.toTaskId && (
                  <span className="flex items-baseline gap-1">
                    →
                    {labels[message.toTaskId] && (
                      <InitiativeLabel label={labels[message.toTaskId]!} className="self-center" />
                    )}
                    {findTask(message.toTaskId)?.name ?? 'workspace'}
                  </span>
                )}
                <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
              </div>
              <p
                className={cn(
                  'whitespace-pre-wrap',
                  isInitiativeEvent(message.kind) && 'text-foreground-muted italic'
                )}
              >
                {splitWorkspaceLinks(message.body).map((part, index) =>
                  'workspaceId' in part ? (
                    <button
                      key={index}
                      type="button"
                      className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded border border-border px-1 align-baseline text-[10px] leading-none font-semibold text-foreground-secondary not-italic hover:bg-background-2"
                      onClick={() => openLinkedWorkspace(part.workspaceId)}
                    >
                      {part.label}
                    </button>
                  ) : (
                    part.text
                  )
                )}
              </p>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <Textarea
            value={draft}
            rows={3}
            placeholder="Message everyone in this initiative"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={controller.dismiss}>
              Close
            </Button>
            <Button type="submit" disabled={!draft.trim()}>
              Send
            </Button>
          </div>
        </form>
      </Dialog.Body>
    </>
  );
});

export const initiativeFeedModal = defineModal<void>()({
  id: 'initiativeFeedModal',
  component: InitiativeFeedModal,
  size: 'md',
});
