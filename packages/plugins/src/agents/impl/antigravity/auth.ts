import type {
  AgentAuthContext,
  AgentAuthStatus,
} from '@emdash/core/services/agent-plugins/api/plugins';
import { commandAuthStatus } from '../../helpers/auth';

/** Gemini API keys and gcloud ADC (`AGY_ADC_AUTH=true`) bypass the Google sign-in. */
export async function antigravityAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  if (ctx.env.GEMINI_API_KEY || ctx.env.AGY_ADC_AUTH === 'true') return { kind: 'authenticated' };
  return commandAuthStatus(ctx, ['models'], {
    authenticatedPattern: /^\S+\t/m,
    unauthenticatedPattern: /please sign in/i,
    timeout: 15_000,
  });
}
