import { useEffect, useState } from 'react';
import { AGENT_PROFILES, type AgentDetection, type AgentInstallResult } from '../../../shared/agents';
import type { AppSettings, ProviderKeyInfo } from '../../../shared/ipc';

export type Tab = 'general' | 'keys' | 'agents';

interface Props {
  initialTab?: Tab;
  open: boolean;
  detections: AgentDetection[];
  onClose: () => void;
  onChange: () => void;
}

interface Provider {
  env: string;
  label: string;
  help: string;
  usedBy: string;
}

/** Every provider we know about. Keys are stored under the env name and injected into agent sessions. */
export const PROVIDERS: Provider[] = [
  {
    env: 'anthropic_api_key',
    label: 'Anthropic',
    help: 'console.anthropic.com → API keys',
    usedBy: 'Claude Code, OpenCode',
  },
  { env: 'openai_api_key', label: 'OpenAI', help: 'platform.openai.com → API keys', usedBy: 'Codex CLI, OpenCode' },
  {
    env: 'gemini_api_key',
    label: 'Google Gemini',
    help: 'aistudio.google.com → Get API key',
    usedBy: 'Gemini CLI, OpenCode',
  },
  {
    env: 'google_api_key',
    label: 'Google (alt name)',
    help: 'Alternate env name some tools expect',
    usedBy: 'Gemini CLI, custom agents',
  },
  {
    env: 'openrouter_api_key',
    label: 'OpenRouter',
    help: 'openrouter.ai → Keys · one key, many models',
    usedBy: 'OpenCode, custom agents',
  },
  { env: 'groq_api_key', label: 'Groq', help: 'console.groq.com → API keys', usedBy: 'OpenCode, custom agents' },
  {
    env: 'mistral_api_key',
    label: 'Mistral',
    help: 'console.mistral.ai → API keys',
    usedBy: 'OpenCode, custom agents',
  },
  { env: 'xai_api_key', label: 'xAI (Grok)', help: 'console.x.ai → API keys', usedBy: 'OpenCode, custom agents' },
  {
    env: 'deepseek_api_key',
    label: 'DeepSeek',
    help: 'platform.deepseek.com → API keys',
    usedBy: 'OpenCode, custom agents',
  },
  {
    env: 'dashscope_api_key',
    label: 'Alibaba DashScope (Qwen)',
    help: 'dashscope.console.aliyun.com',
    usedBy: 'Qwen Code, custom agents',
  },
];

/** Short, human explanations shown under each general setting. */
const HELP: Record<string, string> = {
  theme: 'Dark is the native crewdeck look. System follows Windows.',
  fontSize: 'Pixel size of terminal text. 13–14 is comfortable on 1080p.',
  cursorStyle: 'Shape of the terminal cursor in every pane.',
  scrollback: 'Lines kept per pane. Higher uses more memory; agents can be chatty.',
  lineHeight: 'Multiplier on the font size. 1.2 is tight, 1.5 is airy.',
  fontFamily: 'Any installed monospace font, e.g. "Cascadia Code" or "Fira Code".',
  accent: 'Highlight color for the active pane, buttons and the splash.',
  density: 'Compact trims padding so four panes fit on a laptop screen.',
  startup: 'What the deck does when crewdeck opens.',
  updateChannel: 'Beta gets new builds first; Stable waits for tagged releases.',
  defaultCwd: 'Folder new shells start in when no project is open.',
  defaultAgent: 'Pre-selects this agent when you press New. Works for any installed CLI.',
  shell: 'Program used for plain shell panes, e.g. pwsh.exe, cmd.exe or bash.',
  animations: 'Pane transitions, hover lifts and the splash sequence.',
  confirmOnClose: 'Ask before killing a pane that still has a running process.',
  autoUpdate: 'Download releases in the background and install on next launch.',
  telemetry: 'Anonymous crash and usage counts. Never terminal content or keys.',
  cursorBlink: 'Blink the terminal cursor.',
  reduceMotion: 'Disable non-essential motion, including the mascot wave.',
  restoreSessions: 'Reopen the panes you had when you last quit.',
  notifications: 'Desktop toast when an agent finishes or a process exits.',
  sound: 'Short beep alongside notifications.',
};

export function Settings({ open, detections, onClose, onChange, initialTab }: Props) {
  const [tab, setTab] = useState<Tab>('general');
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);
  const [s, setS] = useState<AppSettings | null>(null);
  const [keys, setKeys] = useState<ProviderKeyInfo[]>([]);
  const [provider, setProvider] = useState(PROVIDERS[0].env);
  const [keyVal, setKeyVal] = useState('');
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<AgentInstallResult[]>([]);
  const [form, setForm] = useState({ name: '', command: '', args: '', env: '' });
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    setErr('');
    window.crewdeck.settings
      .get()
      .then(setS)
      .catch((e: unknown) => setErr(String(e)));
    window.crewdeck.settings
      .listKeys()
      .then(setKeys)
      .catch(() => setKeys([]));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const update = async (patch: Partial<AppSettings>) => {
    try {
      setS(await window.crewdeck.settings.update(patch));
      onChange();
    } catch (e) {
      setErr(String(e));
    }
  };

  const saveKey = async () => {
    try {
      setKeys(await window.crewdeck.settings.setKey(provider.trim(), keyVal));
      setKeyVal('');
      setErr('');
    } catch (e) {
      setErr(String(e));
    }
  };

  const removeKey = async (p: string) => {
    try {
      setKeys(await window.crewdeck.settings.setKey(p, ''));
    } catch (e) {
      setErr(String(e));
    }
  };

  const saveAgent = async () => {
    const nm = form.name.trim().toLowerCase();
    const taken = [
      ...AGENT_PROFILES.flatMap((p) => [p.id.toLowerCase(), p.name.toLowerCase()]),
      ...(s?.customAgents ?? []).flatMap((a) => [a.id.toLowerCase(), a.name.toLowerCase()]),
    ];
    if (nm && taken.includes(nm)) {
      setErr('An agent named "' + form.name.trim() + '" already exists');
      return;
    }
    const badEnv = form.env
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .find((l) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(l));
    if (badEnv) {
      setErr('Invalid environment line "' + badEnv + '" (use KEY=value)');
      return;
    }
    if (!form.name.trim() || !form.command.trim()) {
      setErr('Name and command are required');
      return;
    }
    const env: Record<string, string> = {};
    for (const line of form.env.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    try {
      setS(
        await window.crewdeck.settings.saveAgent({
          name: form.name.trim(),
          command: form.command.trim(),
          args: form.args.split(' ').filter(Boolean),
          env,
        }),
      );
      setForm({ name: '', command: '', args: '', env: '' });
      setErr('');
      onChange();
    } catch (e) {
      setErr(String(e));
    }
  };

  const removeAgent = async (id: string) => {
    try {
      setS(await window.crewdeck.settings.removeAgent(id));
      onChange();
    } catch (e) {
      setErr(String(e));
    }
  };

  const install = async () => {
    if (!picked.length) return;
    setBusy(true);
    setResults([]);
    try {
      setResults(await window.crewdeck.agents.install(picked));
      setPicked([]);
      onChange();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const q = query.trim().toLowerCase();

  const visible = AGENT_PROFILES.filter(
    (p) => p.install && (!q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)),
  );

  const selectAll = () => setPicked(visible.filter((p) => !installed(p.id)).map((p) => p.id));

  const agentBadge = (id: string, ok: boolean) => {
    const r = results.find((x) => x.id === id);

    if (busy && picked.includes(id)) return <span className="badge busy">Installing</span>;

    if (r) return <span className={r.ok ? 'badge ok' : 'badge bad'}>{r.ok ? 'Installed now' : 'Install failed'}</span>;

    return <span className={ok ? 'badge ok' : 'badge'}>{ok ? 'Installed' : 'Not installed'}</span>;
  };

  const installed = (id: string) => detections.find((d) => d.id === id)?.installed ?? false;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-modal="true" aria-label="Settings">
        <header className="settings-head">
          <h2>Settings</h2>
          <button className="icon-btn" title="Close settings" aria-label="Close settings" onClick={onClose}>
            <i className="ri-close-line" />
          </button>
        </header>
        <nav className="settings-tabs" role="tablist">
          {(['general', 'keys', 'agents'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'active' : ''}
              onClick={() => setTab(t)}
            >
              {t === 'general' ? 'General' : t === 'keys' ? 'API keys (BYOK)' : 'Agents (BYOA)'}
            </button>
          ))}
        </nav>
        {err && <div className="settings-error">{err}</div>}
        <div className="settings-body">
          {tab === 'general' && s && (
            <div className="settings-grid">
              <label>
                Theme
                <small className="settings-help">{HELP.theme}</small>
                <select value={s.theme} onChange={(e) => update({ theme: e.target.value as AppSettings['theme'] })}>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">System</option>
                </select>
              </label>
              <label>
                Terminal font size
                <small className="settings-help">{HELP.fontSize}</small>
                <input
                  type="number"
                  min={9}
                  max={28}
                  value={s.fontSize}
                  onChange={(e) => update({ fontSize: Number(e.target.value) })}
                />
              </label>
              <label>
                Cursor style
                <small className="settings-help">{HELP.cursorStyle}</small>
                <select
                  value={s.cursorStyle}
                  onChange={(e) => update({ cursorStyle: e.target.value as AppSettings['cursorStyle'] })}
                >
                  <option value="block">Block</option>
                  <option value="bar">Bar</option>
                  <option value="underline">Underline</option>
                </select>
              </label>
              <label>
                Scrollback lines
                <small className="settings-help">{HELP.scrollback}</small>
                <input
                  type="number"
                  min={500}
                  max={100000}
                  step={500}
                  value={s.scrollback}
                  onChange={(e) => update({ scrollback: Number(e.target.value) })}
                />
              </label>
              <label>
                Line height
                <small className="settings-help">{HELP.lineHeight}</small>
                <input
                  type="number"
                  min={1}
                  max={2}
                  step={0.05}
                  value={s.lineHeight}
                  onChange={(e) => update({ lineHeight: Number(e.target.value) })}
                />
              </label>
              <label>
                Terminal font family
                <small className="settings-help">{HELP.fontFamily}</small>
                <input
                  placeholder="Default monospace"
                  defaultValue={s.fontFamily}
                  onBlur={(e) => e.target.value !== s.fontFamily && update({ fontFamily: e.target.value })}
                />
              </label>
              <label>
                Accent color
                <small className="settings-help">{HELP.accent}</small>
                <input type="color" value={s.accent} onChange={(e) => update({ accent: e.target.value })} />
              </label>
              <label>
                Density
                <small className="settings-help">{HELP.density}</small>
                <select
                  value={s.density}
                  onChange={(e) => update({ density: e.target.value as AppSettings['density'] })}
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
              <label>
                On startup
                <small className="settings-help">{HELP.startup}</small>
                <select
                  value={s.startup}
                  onChange={(e) => update({ startup: e.target.value as AppSettings['startup'] })}
                >
                  <option value="empty">Start empty</option>
                  <option value="last">Reopen last workspace</option>
                  <option value="palette">Open command palette</option>
                </select>
              </label>
              <label>
                Update channel
                <small className="settings-help">{HELP.updateChannel}</small>
                <select
                  value={s.updateChannel}
                  onChange={(e) => update({ updateChannel: e.target.value as AppSettings['updateChannel'] })}
                >
                  <option value="stable">Stable</option>
                  <option value="beta">Beta</option>
                </select>
              </label>
              <label>
                Default working directory
                <small className="settings-help">{HELP.defaultCwd}</small>
                <input
                  placeholder="Home directory"
                  defaultValue={s.defaultCwd}
                  onBlur={(e) => e.target.value !== s.defaultCwd && update({ defaultCwd: e.target.value })}
                />
              </label>
              <label>
                Default agent
                <small className="settings-help">{HELP.defaultAgent}</small>
                <select value={s.defaultAgent} onChange={(e) => update({ defaultAgent: e.target.value })}>
                  <option value="">Ask each time</option>
                  {[...AGENT_PROFILES, ...s.customAgents].map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Shell override
                <small className="settings-help">{HELP.shell}</small>
                <input
                  placeholder="System default"
                  defaultValue={s.shell}
                  onBlur={(e) => e.target.value !== s.shell && update({ shell: e.target.value })}
                />
              </label>
              {(
                [
                  ['animations', 'Animations'],
                  ['confirmOnClose', 'Confirm before closing sessions'],
                  ['autoUpdate', 'Automatic updates'],
                  ['telemetry', 'Anonymous telemetry'],
                  ['cursorBlink', 'Cursor blink'],
                  ['reduceMotion', 'Reduce motion'],
                  ['restoreSessions', 'Restore sessions on launch'],
                  ['notifications', 'Notifications'],
                  ['sound', 'Sound'],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="settings-switch">
                  <input type="checkbox" checked={s[k]} onChange={(e) => update({ [k]: e.target.checked })} />
                  <span className="switch" aria-hidden="true" />
                  <span>
                    {label}
                    <small className="settings-help">{HELP[k]}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
          {tab === 'keys' && (
            <div className="settings-section">
              <p className="settings-hint">
                Bring your own keys. They are encrypted with the Windows credential vault and injected as environment
                variables (e.g. <code>ANTHROPIC_API_KEY</code>) into every agent session, so each CLI picks up the right
                one automatically. Nothing is sent to crewdeck servers.
              </p>
              <div className="settings-row">
                <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
                  {PROVIDERS.map((p) => (
                    <option key={p.env} value={p.env}>
                      {p.label}
                    </option>
                  ))}
                  <option value="">Custom env name…</option>
                </select>
                {provider === '' || !PROVIDERS.some((p) => p.env === provider) ? (
                  <input
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder="MY_PROVIDER_API_KEY"
                    aria-label="Custom env name"
                  />
                ) : null}
                <input
                  type="password"
                  value={keyVal}
                  onChange={(e) => setKeyVal(e.target.value)}
                  placeholder="Paste key"
                  onKeyDown={(e) => e.key === 'Enter' && saveKey()}
                />
                <button className="btn-pop" disabled={!keyVal || !provider.trim()} onClick={saveKey}>
                  Save key
                </button>
              </div>
              <ul className="provider-grid">
                {PROVIDERS.map((p) => {
                  const stored = keys.find((k) => k.provider.toLowerCase() === p.env);
                  return (
                    <li key={p.env} className={stored ? 'stored' : ''}>
                      <div className="provider-head">
                        <strong>{p.label}</strong>
                        <span className={stored ? 'badge ok' : 'badge'}>{stored ? 'Stored' : 'Not set'}</span>
                      </div>
                      <code className="muted">{p.env.toUpperCase()}</code>
                      <span className="muted">{p.help}</span>
                      <span className="muted">Used by: {p.usedBy}</span>
                      <div className="provider-actions">
                        {stored ? (
                          <>
                            <span className="muted">{stored.hint}</span>
                            <button onClick={() => removeKey(stored.provider)}>Remove</button>
                          </>
                        ) : (
                          <button onClick={() => setProvider(p.env)}>Add key</button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {keys.filter((k) => !PROVIDERS.some((p) => p.env === k.provider.toLowerCase())).length > 0 && (
                <ul className="settings-list">
                  {keys
                    .filter((k) => !PROVIDERS.some((p) => p.env === k.provider.toLowerCase()))
                    .map((k) => (
                      <li key={k.provider}>
                        <code>{k.provider.toUpperCase()}</code>
                        <span className="muted">{k.hint}</span>
                        <button onClick={() => removeKey(k.provider)}>Remove</button>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
          {tab === 'agents' && s && (
            <div className="settings-section">
              <h3>Install agents</h3>
              <div className="agent-toolbar">
                <input
                  className="agent-search"
                  type="search"
                  placeholder="Search agents"
                  aria-label="Search agents"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button disabled={busy || !visible.length} onClick={selectAll}>
                  Select all
                </button>
                <button disabled={busy || !picked.length} onClick={() => setPicked([])}>
                  Clear
                </button>
              </div>
              <ul className="agent-catalog">
                {visible.length === 0 && <li className="empty">No agents match "{query}"</li>}
                {visible.map((p) => {
                  const ok = installed(p.id);
                  return (
                    <li key={p.id} className={picked.includes(p.id) ? 'picked' : ''}>
                      <label>
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={picked.includes(p.id)}
                          onChange={() => toggle(p.id)}
                        />
                        <strong>{p.name}</strong>
                        {agentBadge(p.id, ok)}
                      </label>
                      <code className="muted">{p.install}</code>
                    </li>
                  );
                })}
              </ul>
              <button className="btn-pop" disabled={busy || !picked.length} onClick={install}>
                {busy ? 'Installing…' : `Install selected (${picked.length})`}
              </button>
              {results.length > 0 && (
                <ul className="settings-list">
                  {results.map((r) => (
                    <li key={r.id}>
                      <span className={r.ok ? 'badge ok' : 'badge bad'}>{r.ok ? 'OK' : 'Failed'}</span>
                      <strong>{r.id}</strong>
                      <details>
                        <summary>Output</summary>
                        <pre>{r.output}</pre>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
              <h3>Bring your own agent</h3>
              <div className="settings-grid">
                <label>
                  Name
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </label>
                <label>
                  Command
                  <input
                    value={form.command}
                    placeholder="my-agent"
                    onChange={(e) => setForm({ ...form, command: e.target.value })}
                  />
                </label>
                <label>
                  Arguments
                  <input
                    value={form.args}
                    placeholder="--flag value"
                    onChange={(e) => setForm({ ...form, args: e.target.value })}
                  />
                </label>
                <label>
                  Environment (KEY=value per line)
                  <textarea rows={3} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
                </label>
              </div>
              <button className="btn-pop" onClick={saveAgent}>
                Add agent
              </button>
              <ul className="settings-list custom-agents">
                {s.customAgents.length === 0 && <li className="empty">No custom agents</li>}
                {s.customAgents.map((a) => (
                  <li key={a.id}>
                    <strong>{a.name}</strong>
                    <code className="muted">{[a.command, ...a.args].join(' ')}</code>
                    <span className={installed(a.id) ? 'badge ok' : 'badge'}>
                      {installed(a.id) ? 'Found' : 'Not found'}
                    </span>
                    <button onClick={() => removeAgent(a.id)}>Remove</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
