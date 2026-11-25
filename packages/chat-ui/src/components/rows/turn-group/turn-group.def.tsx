import { useTheme } from '@components/contexts/ThemeContext';
import { HEADER_ROW_EXTRA_H } from '@components/engine/row-metrics';
import { CollapseHeader } from '@components/primitives/CollapseHeader';
import type { MeasureCtx } from '@core/define';
import { defineUnit } from '@core/units';
import { For, Show } from 'solid-js';
import type { TurnGroupLine } from '@/model';
import { vars } from '@styles/theme.css';

/** A collapsed turn as rendered: its header label plus a one-line-per-entry log of its items. */
export type TurnGroupData = {
  kind: 'turn-group';
  id: string;
  label: string;
  active: boolean;
  lines: readonly TurnGroupLine[];
};

type TurnGroupVars = { lineH: number; logPadY: number };

const TURN_GROUP_VARS: TurnGroupVars = { lineH: 20, logPadY: 4 };

function headerH(ctx: Pick<MeasureCtx, 'theme'>): number {
  return ctx.theme.fonts.body.lineHeight + HEADER_ROW_EXTRA_H;
}

function turnGroupH(data: TurnGroupData, ctx: MeasureCtx, v: TurnGroupVars): number {
  const height = headerH(ctx);
  if (!ctx.expanded(data.id) || data.lines.length === 0) return height;
  return height + 2 * v.logPadY + data.lines.length * v.lineH;
}

const TONE_COLOR: Record<TurnGroupLine['tone'], string> = {
  prompt: vars.fgMuted,
  assistant: vars.fgMuted,
  tool: vars.fgPassive,
};

export const turnGroupUnitDef = defineUnit<TurnGroupData, TurnGroupVars>({
  kind: 'turn-group',
  margin: { top: 6, bottom: 6 },
  vars: TURN_GROUP_VARS,
  estimate: turnGroupH,
  measure: turnGroupH,

  Render(props) {
    const theme = useTheme();
    const expanded = () => props.ctx.viewState.isCollapsed(props.data.id);
    const hH = () => headerH({ theme: theme() });
    return (
      <div style={{ overflow: 'hidden' }}>
        <CollapseHeader
          id={props.data.id}
          expanded={expanded()}
          active={props.data.active}
          height={hH()}
        >
          {props.data.label}
        </CollapseHeader>
        <Show when={expanded() && props.data.lines.length > 0}>
          <div
            style={{
              padding: `${props.vars.logPadY}px 0 ${props.vars.logPadY}px 12px`,
              'border-left': `1px solid ${vars.border}`,
              'font-size': '12px',
            }}
          >
            <For each={props.data.lines}>
              {(line) => (
                <div
                  title={line.text}
                  style={{
                    height: `${props.vars.lineH}px`,
                    'line-height': `${props.vars.lineH}px`,
                    color: TONE_COLOR[line.tone],
                    'white-space': 'nowrap',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'font-family': line.tone === 'tool' ? vars.fontMono : undefined,
                  }}
                >
                  {line.text}
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    );
  },
});
