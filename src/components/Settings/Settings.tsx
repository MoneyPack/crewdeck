import { useEffect, useState } from 'react';
import { AGENT_PROFILES, type AgentDetection, type AgentInstallResult } from '../../../shared/agents';
import type { AppSettings, ProviderKeyInfo } from '../../../shared/ipc';

type Tab = 'general' | 'keys' | 'agents';

interface Props {
  open: boolean;
  detections: AgentDetection[];
  onClose: () => void;
  onChange: () => void;
}

const PROVIDERS = ['anthropic_api_key', 'openai_api_key', 'gemini_api_key', 'openrouter_api_key', 'dashscope_api_key'];

export function Settings({ open, detections, onClose, onChange }: Props) {
  const [tab, setTab] = useState<Tab>('general');
  const [s, setS] = useState<AppSettings | null>(null);
  const [keys, setKeys] = useState<ProviderKeyInfo[]>([]);
  const [provider, setProvider] = useState(PROVIDERS[0]);
  const [keyVal, setKeyVal] = useState('');
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<AgentInstallResult[]>([]);
  const [form, setForm] = useState({ name: '', command: '', args: '', env: '' });

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
                <select value={s.theme} onChange={(e) => update({ theme: e.target.value as AppSettings['theme'] })}>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">System</option>
                </select>
              </label>
              <label>
                Terminal font size
                <input
                  type="number"
                  min={9}
                  max={28}
                  value={s.fontSize}
                  onChange={(e) => update({ fontSize: Number(e.target.value) })}
                />
              </label>
              <label>
                Default agent
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
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="settings-switch">
                  <input type="checkbox" checked={s[k]} onChange={(e) => update({ [k]: e.target.checked })} />
                  <span className="switch" aria-hidden="true" />
                  {label}
                </label>
              ))}
            </div>
          )}
          {tab === 'keys' && (
            <div className="settings-section">
              <p className="settings-hint">
                Keys are encrypted with your OS keychain and injected as environment variables into agent sessions.
              </p>
              <div className="settings-row">
                <input
                  list="cd-providers"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  placeholder="ENV_NAME"
                />
                <datalist id="cd-providers">
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
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
              <ul className="settings-list">
                {keys.length === 0 && <li className="empty">No keys stored</li>}
                {keys.map((k) => (
                  <li key={k.provider}>
                    <code>{k.provider.toUpperCase()}</code>
                    <span className="muted">{k.hint}</span>
                    <button onClick={() => removeKey(k.provider)}>Remove</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {tab === 'agents' && s && (
            <div className="settings-section">
              <h3>Install agents</h3>
              <ul className="agent-catalog">
                {AGENT_PROFILES.filter((p) => p.install).map((p) => {
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
                        <span className={ok ? 'badge ok' : 'badge'}>{ok ? 'Installed' : 'Not installed'}</span>
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
              <ul className="settings-list">
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
