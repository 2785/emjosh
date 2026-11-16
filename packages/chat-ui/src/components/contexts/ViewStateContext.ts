/**
 * ViewStateContext — the conversation's ViewState (per-item toggles such as collapse or a
 * table's wrapping) for renderers that toggle their own item, e.g. a table's Wrap button.
 */

import { createContext, useContext } from 'solid-js';
import type { ViewState } from '@/state/view-state';

export const ViewStateContext = createContext<(() => ViewState) | undefined>(undefined);

export const useViewState = (): (() => ViewState) | undefined => useContext(ViewStateContext);
