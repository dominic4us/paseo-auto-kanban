/**
 * REQ-73: what the card face says about its agents. Pure derivation only: no React, no SDK, no ledger.
 * Line one leads with the agent's state drawn as Paseo's sidebar draws it; line two names the lead agent
 * by its provider mark and a name, and ends with how long ago the card last changed.
 */
import type { AgentModelInfo, SignalBucket } from './signal-model.js';

/**
 * The sidebar's state mark for a bucket (Paseo 0.9.1 web bundle, `SidebarWorkspaceRow` status slot):
 * running spins a ring, needs_input is a filled CircleAlert, failed / finished-unseen / finished are 6px
 * dots. The sidebar has nothing for "status unavailable" or for Kanban's own "nobody left" (REQ-51), so
 * those draw no mark here; the orphaned card shows its warning on line two instead.
 */
export type SidebarMark = 'ring' | 'alert' | 'dot-danger' | 'dot-success' | 'dot-idle';
export function sidebarMark(bucket: SignalBucket): SidebarMark | null {
  return bucket === 'working' ? 'ring' : bucket === 'permission' ? 'alert' : bucket === 'error' ? 'dot-danger'
    : bucket === 'attention' ? 'dot-success' : bucket === 'idle' ? 'dot-idle' : null;
}

/** Providers Paseo draws with its own mark; any other provider gets Paseo's generic `Bot` glyph. */
export type ProviderKey = 'claude' | 'codex' | 'gemini';
export function providerKey(provider: string | null | undefined): ProviderKey | null {
  const id = (provider ?? '').trim().toLowerCase().replace(/-acp$/, '');
  return id === 'claude' ? 'claude' : id === 'codex' || id === 'openai' ? 'codex' : id === 'gemini' ? 'gemini' : null;
}
/** The provider in plain words, for the mark's accessibility label and the tooltip. */
export function providerName(provider: string | null | undefined): string | null {
  const key = providerKey(provider);
  if (key) return { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[key];
  const id = (provider ?? '').trim();
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : null;
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
/** Words a Gemini id carries that say nothing about which model it is. */
const GEMINI_NOISE = new Set(['preview', 'latest', 'exp']);
/**
 * A short, readable model name from an SDK model id:
 * - Claude `claude-<family>-<major>[-<minor>][-<yyyymmdd>]` → "Opus 5.5", "Haiku 4.5" (a `[1m]` context
 *   suffix and a provider prefix such as `us.anthropic.` are dropped); the older `claude-3-5-sonnet` → "Sonnet 3.5"
 * - OpenAI `gpt-<version>[-<name>…]` → "GPT-6 Astra", "GPT-5.5"
 * - Gemini `gemini-<version>-<words>` → "Gemini 3.1 Pro" ("preview", "latest", "exp" dropped)
 * - `auto` / `default` → "<Provider> Auto"
 * Anything else is shown as the id itself; no model at all gives null.
 */
export function modelShortName(info: Pick<AgentModelInfo, 'provider' | 'model'> | null | undefined): string | null {
  const raw = info?.model?.trim();
  if (!raw) return null;
  const id = raw.replace(/\[[^\]]*\]$/, '').replace(/^(?:[a-z]{2,4}\.)?anthropic\./i, '').toLowerCase();
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:-v\d+(?::\d+)?)?$/.exec(id);
  if (claude) return capital(claude[1]!) + ' ' + claude[2] + (claude[3] ? '.' + claude[3] : '');
  const older = /^claude-(\d+)(?:-(\d))?-([a-z]+)(?:-\d{8})?$/.exec(id);
  if (older) return capital(older[3]!) + ' ' + older[1] + (older[2] ? '.' + older[2] : '');
  const gpt = /^gpt-(\d+(?:\.\d+)?)((?:-[a-z0-9.]+)*)$/.exec(id);
  if (gpt) return ['GPT-' + gpt[1], ...gpt[2]!.split('-').filter(Boolean).map(capital)].join(' ');
  const gemini = /^gemini-(\d+(?:\.\d+)?)((?:-[a-z0-9.]+)*)$/.exec(id);
  if (gemini) return ['Gemini', gemini[1]!, ...gemini[2]!.split('-').filter(w => w && !GEMINI_NOISE.has(w)).map(capital)].join(' ');
  if (id === 'auto' || id === 'default') return [providerName(info?.provider), capital(id)].filter(Boolean).join(' ');
  return raw;
}

/**
 * REQ-126: the model's display name — the host's own (`modelLabel`, from the provider's model list: "Opus 5.5",
 * "GPT-6.1-Sol"), else the short name read from its id (`modelShortName`), else null.
 */
export function modelDisplayName(info: Pick<AgentModelInfo, 'provider' | 'model' | 'modelLabel'> | null | undefined): string | null {
  return info?.modelLabel?.trim() || modelShortName(info);
}
/** REQ-126: a model name's version, its first run of digits: "Opus 5.5" → "5.5", "GPT-6-Astra" → "6", "Gemini 3.5 Flash" → "3.5". */
export function modelVersion(name: string | null | undefined): string | null {
  return /\d+(?:\.\d+)*/.exec(name ?? '')?.[0] ?? null;
}
/** REQ-126: a thinking option id in words: its first letter capital, "xhigh" → "XHigh"; none gives null. */
export function thinkingText(id: string | null | undefined): string | null {
  const word = (id ?? '').trim();
  if (!word) return null;
  return /^x(?:high|low)$/i.test(word) ? 'X' + capital(word.slice(1).toLowerCase()) : capital(word);
}
/** A profile label from before 09-30 ends with its model's version ("실행_Sol-6", "총괄_Opus-5.5"). */
const VERSIONED_LABEL = /-\d+(?:\.\d+)*$/;
/**
 * REQ-126: an agent's model name with its version and thinking level, "<profile label>-<version>-<thinking>":
 * "실행_Sol-6.1-High". A label that already ends with a version ("총괄_Opus-5.5") takes the thinking level only; an agent
 * with no label is named by its model ("Opus-5.5-High"); a part the host does not say is left out. Null with neither a
 * label nor a model. An archived agent keeps the last values the host gave. The thinking level is the agent's own
 * `thinkingOptionId` only: none (null, undefined, empty) leaves it out, whatever the provider runs with by default.
 */
export function agentModelName(info: AgentModelInfo | null | undefined): string | null {
  const profile = info?.profile?.trim(), model = modelDisplayName(info);
  const thinking = thinkingText(info?.thinkingOptionId);
  if (profile) {
    const version = VERSIONED_LABEL.test(profile) ? null : modelVersion(model);
    return [profile, version, thinking].filter(Boolean).join('-');
  }
  return model ? [model.replace(/\s+/g, '-'), thinking].filter(Boolean).join('-') : null;
}

/**
 * The name line two shows for an agent, first present of: the `profile` label the agent was created with
 * (the Paseo profile name) or else its model, with the version and thinking level (REQ-126 `agentModelName`), the
 * agent's own title, and its id's first 8 characters.
 * The order is strict: a title equal to the card's own (an auto card, REQ-61) is still the title.
 * REQ-78 ④: while the agent is still being looked up (`pending`), a neutral `PENDING_NAME` stands where the id would
 * be; the id is the name only once the lookup has answered without one.
 */
export const PENDING_NAME = '…';
export function assigneeName(agentId: string, info: AgentModelInfo | null | undefined, pending = false): string {
  const named = agentModelName(info);
  if (named) return named;
  const title = info?.title?.trim();
  if (title) return title;
  return pending ? PENDING_NAME : agentId.slice(0, 8);
}

/**
 * REQ-77 ①: the id's first 8 characters to show after a name, or '' when the name already is them — an agent
 * Kanban cannot read is named by its id, and its row must not say it twice.
 */
export function agentIdSuffix(agentId: string, name: string): string {
  const short = agentId.slice(0, 8);
  return name === short ? '' : short;
}

/** "Name · +2": the lead agent, and how many more are linked. */
export function assigneeLine(name: string, others: number, otherAgents: (count: number) => string): string {
  return others > 0 ? `${name} · ${otherAgents(others)}` : name;
}

/** How long ago, in the largest whole unit: just now, minutes, hours, days, months (30 days), years (365 days). */
export type Elapsed = { unit: 'now' } | { unit: 'minute' | 'hour' | 'day' | 'month' | 'year'; count: number };
export function elapsed(since: string | null | undefined, now: number): Elapsed | null {
  const at = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor((now - at) / 60000);
  // A clock a little ahead of this device still reads as "just now", never as a negative age.
  if (minutes < 1) return { unit: 'now' };
  if (minutes < 60) return { unit: 'minute', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hour', count: hours };
  const days = Math.floor(hours / 24);
  if (days < 30) return { unit: 'day', count: days };
  if (days < 365) return { unit: 'month', count: Math.floor(days / 30) };
  return { unit: 'year', count: Math.floor(days / 365) };
}
