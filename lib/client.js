window.__ModuleLoader__.load({
  id: 'dsh-ntr-zcode',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const css = `.ntr{max-width:760px;letter-spacing:0}.ntr h2{font-size:20px;margin:0 0 20px}.ntr fieldset{border:0;padding:0;margin:0 0 20px}.ntr label{display:flex;gap:10px;align-items:flex-start;margin:12px 0;font-size:14px}.ntr small{display:block;color:var(--dsw-alias-label-secondary,#888);overflow-wrap:anywhere}.ntr-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0}.ntr button{font:inherit;padding:8px 14px;border:1px solid #7777;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.ntr button:disabled{opacity:.45;cursor:not-allowed}.ntr-qr{display:block;width:280px;max-width:100%;height:auto;aspect-ratio:1}.ntr-status{font-size:15px;padding:16px 0;border-top:1px solid #7774}.ntr-error{color:#e46969;overflow-wrap:anywhere}.ntr-warning{color:#d09b40;font-size:13px;line-height:1.7}`;
    const labels = { stopped: '未开启', connecting: '正在连接中继', waiting: '等待手机连接', connected: '手机已连接', error: '连接失败' };
    async function api(body, signal) {
      const response = await fetch(new URL('api/plugins/dsh-ntr-zcode/remote', new URL('.', window.location.href)), {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return value;
    }
    function Settings() {
      const [state, setState] = React.useState(null);
      const [selected, setSelected] = React.useState([]);
      const [consent, setConsent] = React.useState(false);
      const [allowPermissions, setAllowPermissions] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [copied, setCopied] = React.useState(false);
      const initialized = React.useRef(false);
      React.useEffect(() => {
        const abort = new AbortController();
        let timer;
        const poll = async () => {
          try {
            const value = await api(null, abort.signal);
            if (!abort.signal.aborted) {
              setState(value);
              if (!initialized.current) {
                initialized.current = true;
                setSelected(value.selected ?? []);
                setConsent(!['stopped', 'error'].includes(value.state));
                setAllowPermissions(value.allowPermissionChanges === true);
              }
            }
          } catch (e) { if (!abort.signal.aborted) setError(e.message); }
          if (!abort.signal.aborted) timer = setTimeout(poll, 2500);
        };
        void poll();
        return () => { abort.abort(); clearTimeout(timer); };
      }, []);
      async function act(action) {
        setBusy(true); setError(''); setCopied(false);
        try { setState(await api({ action, consent, allowPermissionChanges: allowPermissions, workspaces: selected.length ? selected : state?.selected })); }
        catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }
      const active = state && !['stopped', 'error'].includes(state.state);
      return h('section', { className: 'ntr' },
        h('h2', null, 'Dsh ntr Zcode'),
        h('fieldset', { disabled: busy || active }, h('legend', null, '共享工作区'),
          ...(state?.workspaces ?? []).map(w => h('label', { key: w.id },
            h('input', { type: 'checkbox', checked: (active ? state.selected : selected).includes(w.id),
              onChange: e => setSelected(list => e.target.checked ? [...list, w.id] : list.filter(id => id !== w.id)) }),
            h('span', null, w.title || w.path, h('small', null, `${w.sessions} 个会话 · ${w.path}`))))),
        h('p', { className: 'ntr-warning' }, '实验版：所选工作区的会话、消息和图片经 ZCode 官方中继传输。WSS 不是端到端加密；持有链接者可读取会话并向 DSH 发送任务。请勿分享二维码。模式映射：变更前确认→仅可查看（更严格）；自动编辑→工作区内修改；完全访问→完全权限。需要确认的操作仍在 DSH 桌面批准。'),
        h('label', null, h('input', { type: 'checkbox', checked: allowPermissions, disabled: busy || active,
          onChange: e => setAllowPermissions(e.target.checked) }), '允许手机切换 DSH 权限（含完全权限）'),
        h('label', null, h('input', { type: 'checkbox', checked: consent, disabled: busy,
          onChange: e => { setConsent(e.target.checked); if (!e.target.checked && active) void act('stop'); } }), '允许手机通过官方中继访问所选工作区'),
        h('div', { className: 'ntr-status', role: 'status' }, labels[state?.state] || '正在读取 DSH'),
        h('div', { className: 'ntr-actions' },
          h('button', { disabled: busy || (!active && (!consent || !selected.length)), onClick: () => act(active ? 'stop' : 'start') }, active ? '停止' : '开启远程'),
          h('button', { disabled: busy || !active || !consent, onClick: () => act('refresh') }, '刷新二维码'),
          h('button', { disabled: busy || !state?.link, onClick: async () => {
            try { await navigator.clipboard.writeText(state.link); setCopied(true); } catch { setError('复制失败，请直接扫描二维码'); }
          } }, copied ? '已复制' : '复制链接')),
        state?.qr ? h('img', { className: 'ntr-qr', src: state.qr, alt: '手机远程配对二维码', width: 280, height: 280 }) : null,
        error || state?.error ? h('p', { className: 'ntr-error', role: 'alert' }, error || state.error) : null);
    }
    return { inject: ['slots'], apply(ctx) {
      ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); return () => style.remove(); }, 'Dsh ntr Zcode styles');
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-ntr-zcode', order: 13,
        label: () => 'Dsh ntr Zcode', inject: () => ({}) }, Settings));
    } };
  },
});
