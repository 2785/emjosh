import { SettingsCard } from '@emdash/ui/react/patterns';
import { Select, SeparatedList, Switch } from '@emdash/ui/react/primitives';
import React from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { InterfaceSettings } from '@core/primitives/app-settings/api/app-settings';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

const ChatDisplaySettingsCard: React.FC = () => {
  const { value, update, isLoading, isSaving, isFieldOverridden, resetField } =
    useAppSettingsKey('interface');
  const busy = isLoading || isSaving;
  const chatWidth = value?.chatWidth ?? 'wide';
  const wrapCodeBlocks = value?.wrapCodeBlocks ?? true;

  return (
    <SettingsCard>
      <SeparatedList gap="1rem" direction="column">
        <SettingRow
          title="Chat width"
          description="How wide chat messages can grow in a wide window."
          control={
            <>
              <ResetToDefaultButton
                visible={isFieldOverridden('chatWidth')}
                defaultLabel="wide"
                onReset={() => resetField('chatWidth')}
                disabled={busy}
              />
              <Select.Root
                value={chatWidth}
                disabled={busy}
                onValueChange={(next) =>
                  update({ chatWidth: next as InterfaceSettings['chatWidth'] })
                }
              >
                <Select.Trigger className="w-auto shrink-0 gap-2 [&>span]:line-clamp-none">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content className="min-w-max">
                  <Select.Item value="comfortable">Comfortable</Select.Item>
                  <Select.Item value="wide">Wide</Select.Item>
                  <Select.Item value="full">Full width</Select.Item>
                </Select.Content>
              </Select.Root>
            </>
          }
        />
        <SettingRow
          title="Wrap code blocks"
          description="Wrap long lines in chat code blocks instead of scrolling them sideways."
          control={
            <>
              <ResetToDefaultButton
                visible={isFieldOverridden('wrapCodeBlocks')}
                defaultLabel="on"
                onReset={() => resetField('wrapCodeBlocks')}
                disabled={busy}
              />
              <Switch
                checked={wrapCodeBlocks}
                onCheckedChange={(checked) => update({ wrapCodeBlocks: checked })}
                disabled={busy}
                aria-label="Wrap code blocks"
              />
            </>
          }
        />
      </SeparatedList>
    </SettingsCard>
  );
};

export default ChatDisplaySettingsCard;
