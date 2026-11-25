import { defineCommand } from '@core/primitives/commands/api';
import { keybinding } from '@core/primitives/keybindings/api';

export const findWorkspaceCommand = defineCommand({
  id: 'workspace.find',
  title: 'Find Workspace',
  description: 'Find a workspace by PR/MR, branch, ticket, id, or a description of its work',
  category: 'Navigation',
  icon: 'search',
  keybinding: keybinding.settings('findWorkspace', 'Mod+Shift+K'),
});

export const WORKSPACE_CONTROL_COMMAND_DEFS = [findWorkspaceCommand] as const;
