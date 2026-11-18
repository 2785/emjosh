import { PageLayout, SettingsSection } from '@emdash/ui/react/patterns';
import ChatDisplaySettingsCard from '../components/ChatDisplaySettingsCard';
import FilesSettingsCard from '../components/FilesSettingsCard';
import FrameTintCard from '../components/FrameTintCard';
import HiddenToolsSettingsCard from '../components/HiddenToolsSettingsCard';
import InterfaceSettingsCard from '../components/InterfaceSettingsCard';
import KeyboardSettingsCard from '../components/KeyboardSettingsCard';
import { LinkOpenBehaviorRow } from '../components/LinkOpenBehaviorRow';
import SidebarMetadataSettingsCard from '../components/SidebarMetadataSettingsCard';
import TerminalSettingsCard from '../components/TerminalSettingsCard';
import ThemeCard from '../components/ThemeCard';
import { TrayIconSettingsRow } from '../components/TrayIconSettingsRow';

export function InterfaceSettingsPage() {
  return (
    <div className="space-y-8 pb-4">
      <PageLayout.Header
        sticky
        title="Interface"
        description="Customize the appearance and behavior of the app."
      />
      <SettingsSection title="Color mode" bare>
        <ThemeCard />
      </SettingsSection>
      <SettingsSection title="Window frame color" bare>
        <p className="mb-3 text-sm text-foreground-muted">
          Tints the title bar and sidebar so this window is easy to spot. Each color has a darker
          variant for dark mode and a brighter one for light mode.
        </p>
        <FrameTintCard />
      </SettingsSection>
      <SettingsSection title="Application icon">
        <TrayIconSettingsRow />
      </SettingsSection>
      <SettingsSection title="Links">
        <LinkOpenBehaviorRow />
      </SettingsSection>
      <SettingsSection title="Chat" bare>
        <ChatDisplaySettingsCard />
      </SettingsSection>
      <SettingsSection title="Terminal" bare>
        <TerminalSettingsCard />
      </SettingsSection>
      <SettingsSection title="Files" bare>
        <FilesSettingsCard />
      </SettingsSection>
      <SettingsSection title="Sidebar" bare>
        <SidebarMetadataSettingsCard />
      </SettingsSection>
      <SettingsSection bare>
        <InterfaceSettingsCard />
      </SettingsSection>
      <SettingsSection title="Keyboard shortcuts" bare>
        <KeyboardSettingsCard />
      </SettingsSection>
      <SettingsSection title="Tools" bare>
        <HiddenToolsSettingsCard />
      </SettingsSection>
    </div>
  );
}
