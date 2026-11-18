import { join } from 'node:path';
import { app } from 'electron';
import iconFile from '@/assets/images/emjosh/emjosh.png?asset';
import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';
import { serveDesktopWire } from '@main/gateway/desktop-wire';
import { log } from '@main/lib/logger';
import { RemoteControlService } from '@main/remote-control/remote-control-service';
import { RemoteControlStore } from '@main/remote-control/remote-control-store';

let service: RemoteControlService | undefined;

/** The process-wide remote control service; its state lives in `<userData>/remote-control.json`. */
export function getRemoteControlService(): RemoteControlService {
  service ??= new RemoteControlService({
    store: new RemoteControlStore(join(app.getPath('userData'), 'remote-control.json')),
    rendererRoot: join(app.getAppPath(), 'out', 'renderer'),
    iconFile,
    productName: PRODUCT_NAME,
    serveWire: serveDesktopWire,
    logger: log,
  });
  return service;
}
