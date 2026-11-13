import { z } from 'zod';
import { COMMAND_CATALOG } from '@core/manifests/shared/command-catalog';
import type {
  InterfaceSettings,
  KeyboardSettings,
  OpenInSettings,
  Theme,
} from '@core/primitives/app-settings/api';
import { openInAppIdSchema } from '@core/primitives/open-in-apps/api/open-in-apps';
import { defineSettingsContribution } from '@core/primitives/settings/api';
import { FRAME_TINT_IDS, type FrameTint } from '@core/primitives/theme/api/frame-tint';

const keyboardSettingsSchema = z
  .optional(
    z.object(
      Object.fromEntries(
        COMMAND_CATALOG.defs.flatMap((command) =>
          command.keybinding?.kind === 'settings'
            ? [[command.keybinding.settingsKey, z.string().nullable().optional()]]
            : []
        )
      ) as Record<string, z.ZodOptional<z.ZodNullable<z.ZodString>>>
    )
  )
  .default({});

const interfaceSettingsSchema = z.object({
  showTrayIcon: z.boolean(),
  taskHoverAction: z.enum(['delete', 'archive']),
  autoRightSidebarBehavior: z.boolean(),
  showLeftSidebarLineChanges: z.boolean(),
  showLeftSidebarPrStatus: z.boolean(),
  showLeftSidebarTimestamps: z.boolean(),
  hideContextBar: z.boolean(),
  chatWidth: z.enum(['comfortable', 'wide', 'full']),
  wrapCodeBlocks: z.boolean(),
});

const themeSchema = z.enum(['emlight', 'emdark']).nullable().catch(null).optional().default(null);

const openInSettingsSchema = z.object({
  default: openInAppIdSchema,
  hidden: z.array(openInAppIdSchema),
});

export const keyboardSettingsContribution = defineSettingsContribution<
  'keyboard',
  KeyboardSettings
>({
  key: 'keyboard',
  schema: keyboardSettingsSchema,
  defaults: {},
});

export const interfaceSettingsContribution = defineSettingsContribution<
  'interface',
  InterfaceSettings
>({
  key: 'interface',
  schema: interfaceSettingsSchema,
  defaults: {
    showTrayIcon: true,
    taskHoverAction: 'delete',
    autoRightSidebarBehavior: false,
    showLeftSidebarLineChanges: false,
    showLeftSidebarPrStatus: true,
    showLeftSidebarTimestamps: true,
    hideContextBar: false,
    chatWidth: 'wide',
    wrapCodeBlocks: true,
  },
});

export const themeSettingsContribution = defineSettingsContribution<'theme', Theme>({
  key: 'theme',
  schema: themeSchema,
  defaults: null,
});

export const frameTintSettingsContribution = defineSettingsContribution<'frameTint', FrameTint>({
  key: 'frameTint',
  schema: z.enum(['none', ...FRAME_TINT_IDS]).catch('none'),
  defaults: 'none',
});

/** Where clicked links open: ask each time, or always use the remembered choice. */
export const linkOpenBehaviorSettingsContribution = defineSettingsContribution<
  'linkOpenBehavior',
  'ask' | 'emdash-browser' | 'external-browser'
>({
  key: 'linkOpenBehavior',
  schema: z.enum(['ask', 'emdash-browser', 'external-browser']).catch('ask'),
  defaults: 'ask',
});

export const openInSettingsContribution = defineSettingsContribution<'openIn', OpenInSettings>({
  key: 'openIn',
  schema: openInSettingsSchema,
  defaults: {
    default: 'terminal',
    hidden: [],
  },
});
