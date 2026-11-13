import { Smartphone } from 'lucide-react';
import { switchToMobileView } from './use-mobile-layout';

/** On a phone showing the desktop view: the way back to the mobile layout. */
export function MobileViewButton() {
  return (
    <button
      type="button"
      onClick={switchToMobileView}
      className="fixed right-3 bottom-3 z-[60] flex items-center gap-1.5 rounded-full bg-foreground px-3 py-2 text-sm font-medium text-background shadow-lg"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      <Smartphone className="size-4" />
      Mobile view
    </button>
  );
}
