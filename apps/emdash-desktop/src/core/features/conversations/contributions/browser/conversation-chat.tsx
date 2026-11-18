import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { AcpChatView } from '@core/features/conversations/browser/acp/acp-chat-panel';
import { getAcpChatResourceManager } from '@core/features/conversations/browser/acp/acp-chat-resource-manager';
import type { AcpChatStore } from '@core/features/conversations/browser/acp/acp-chat-store';

/**
 * A chat conversation outside the workbench's tabs (the mobile layout): holds the conversation's
 * chat store while mounted, like an open tab does.
 */
export const ConversationChat = observer(function ConversationChat({
  projectId,
  taskId,
  conversationId,
}: {
  projectId: string;
  taskId: string;
  conversationId: string;
}) {
  const [store, setStore] = useState<AcpChatStore | null>(null);

  useEffect(() => {
    const manager = getAcpChatResourceManager(taskId, projectId);
    const acquired = manager.acquire(conversationId);
    acquired.bootstrap();
    setStore(acquired);
    const conversation = conversationRegistry.get(taskId)?.conversations.get(conversationId);
    if (conversation && !conversation.seen) conversation.markSeen();
    return () => {
      setStore(null);
      manager.release(conversationId);
    };
  }, [projectId, taskId, conversationId]);

  return <AcpChatView store={store} />;
});
