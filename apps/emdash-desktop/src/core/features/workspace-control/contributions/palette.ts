import { defineCommandPaletteItem } from '@core/primitives/palette/api';
import { findWorkspaceCommand } from './commands';

export const WORKSPACE_CONTROL_COMMAND_PALETTE_ITEMS = [
  defineCommandPaletteItem({
    command: findWorkspaceCommand,
    aliases: ['which workspace', 'search workspaces', 'pull request', 'merge request'],
  }),
] as const;
