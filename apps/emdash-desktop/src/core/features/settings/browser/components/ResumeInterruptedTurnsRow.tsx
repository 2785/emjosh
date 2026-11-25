import { Switch } from '@emdash/ui/react/primitives';
import React from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

export const ResumeInterruptedTurnsRow: React.FC = () => {
  const { value, defaults, isOverridden, isLoading, isSaving, update, reset } =
    useAppSettingsKey('resumeInterruptedTurns');
  const title = 'Keep agents going after a restart';
  const disabled = isLoading || isSaving;

  return (
    <SettingRow
      title={title}
      description={`When ${PRODUCT_NAME} quits, restarts, or crashes while a chat agent is working, send it an automatic message to keep going once ${PRODUCT_NAME} is back. Applies to local chat conversations.`}
      control={
        <>
          <ResetToDefaultButton
            visible={isOverridden}
            defaultLabel="on"
            onReset={() => reset()}
            disabled={disabled}
          />
          <Switch
            aria-label={title}
            checked={value ?? defaults ?? true}
            disabled={disabled}
            onCheckedChange={(checked) => update(checked)}
          />
        </>
      }
    />
  );
};
