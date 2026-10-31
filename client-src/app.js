// Presence client application. This module is bundled into ../client.js by
// scripts/build-client.mjs - edit here, never in the generated file.

import { mountCodeView } from './editor.js';
import {
  detectJobExits,
  isMissingEndpointError,
  isSuccessfulExit,
  joinRemotePath,
  normalizeOctalMode,
  parentRemotePath,
  remoteBaseName,
  splitDiffLines,
} from './features.js';
import {
  FINISHED_HOLD_MS,
  POLL_COLLAPSED_MS,
  POLL_EXPANDED_MS,
  computeEta,
  dockPresentation,
  elapsedMs,
  formatClock,
  formatDurationShort,
  formatElapsed,
  formatProgress,
  normalizeWaitsPayload,
  pillLabelText,
  progressRatio,
  reduceSamples,
} from './waits-ui.js';

export function createApp({ React, ReactDOM }) {
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API = '/api/presence';

    async function request(path, body, method) {
      const verb = method ?? (body === undefined ? 'GET' : 'POST');
      const init = { method: verb, headers: { accept: 'application/json' } };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(API + path, init);
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    }

    // ------------------------------------------------------------ i18n
    // The harness UI is Chinese by default; if the page declares English the
    // catalogue falls back to English copy with the raw detail kept underneath.
    // Read lazily: the locale plugin sets <html lang> after plugins are loaded,
    // so a constant captured at module-eval time can be wrong.
    function currentLocale() {
      try {
        const lang = (document.documentElement.lang || '').toLowerCase();
        if (lang) return lang.startsWith('zh') ? 'zh' : 'en';
        const nav = (navigator.language || '').toLowerCase();
        return nav.startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'zh';
      }
    }

    const MESSAGES = {
      zh: {
        'toast.copyFailed': '复制失败',
        'toast.copyFailed.hint': '浏览器拒绝了剪贴板操作，可以手动选中内容复制',
        'toast.copied': '已复制到剪贴板',
        'toast.connectionFailed': '连接失败',
        'toast.loadFailed': '加载失败',
        'toast.openFailed': '打开失败',
        'toast.actionFailed': '操作失败',
        'toast.forwardOpened': '端口转发已建立',
        'toast.forwardClosed': '端口转发已停止',
        'toast.hostAdded': '主机已添加',
        'toast.hostRemoved': '主机已删除',
        'toast.uploaded': '上传完成',
        'toast.downloaded': '下载完成',
        'err.auth.title': '需要密码登录',
        'err.auth.hint': '先在这个面板连接一次（可勾选记住密码），再重试',
        'err.portClosed.title': '远程 {target} 上没有服务在监听',
        'err.portClosed.hint': '先在 {host} 上启动服务（或检查端口号），再试一次',
        'err.refused.title': '连接被拒绝',
        'err.refused.hint': '检查远程 sshd 是否运行、端口是否正确',
        'err.dns.title': '主机名无法解析',
        'err.dns.hint': '检查 ssh config / 手动主机里的 HostName',
        'err.timeout.title': '连接超时',
        'err.timeout.hint': '网络不通或被防火墙拦截',
        'err.unknownHost.title': '找不到这台机器',
        'err.unknownHost.hint': '到「设置 → Presence」检查主机是否还在 ssh config 或手动主机里',
        'err.permission.title': '权限不足',
        'err.permission.hint': '远程用户没有访问该路径或资源的权限',
        'err.noSuchFile.title': '文件或目录不存在',
        'err.noSuchFile.hint': '检查路径拼写，或刷新目录后重试',
        'err.remote.title': '远程操作失败',
        'err.remote.hint': '下面保留了原始报错，可据此继续排查',
        'err.generic.title': '操作失败',
        'err.generic.hint': '请检查连接与参数后重试',
        'toast.mkdirDone': '已新建文件夹',
        'toast.renamed': '已重命名',
        'toast.chmodDone': '权限已修改',
        'toast.copiedPath': '已复制远程路径',
        'toast.deleted': '已移到远端回收站',
        'toast.discovered': '发现 {count} 个新端口',
        'toast.discovered.hint': '点端口标签上的「转发」即可在本地打开',
        'toast.jobSuccess': '任务完成',
        'toast.jobFailed': '任务失败',
        'toast.jobEnded': '任务已结束',
        'toast.jobExitCode': '退出码 {code}',
        'toast.jobSignal': '信号 {signal}',
        'toast.presetSaved': '已保存自动恢复预设',
        'toast.presetKept': '已保存转发预设',
        'toast.presetRemoved': '已删除转发预设',
        'toast.presetUpdated': '转发预设已更新',
        'toast.diffNeedTarget': '请填写要对比的另一个文件',
        'toast.diffNeedTarget.hint': 'B 可以是同一台机器上的另一个路径，也可以是本地文件',
        'toast.unsupportedFeature': '当前版本不支持这个功能',
        'toast.unsupportedFeature.hint': '把 Presence 升级到 0.18.0 之后再试',
        'toast.notifyDenied': '浏览器通知未开启',
        'toast.notifyDenied.hint': '可以在浏览器地址栏的权限设置里允许通知；站内提示仍会保留',
        'waitDock.title': '等待任务',
        'waitDock.expand': '展开等待面板',
        'waitDock.collapse': '收起',
        'waitDock.back': '返回',
        'waitDock.running': '{count} 个等待',
        'waitDock.donePill': '{count} 个已完成',
        'waitDock.runningChip': '{count} 运行中',
        'waitDock.finishedChip': '{count} 已完成',
        'waitDock.state.running': '运行中',
        'waitDock.state.done': '已完成',
        'waitDock.state.timeout': '已超时',
        'waitDock.state.error': '失败',
        'waitDock.status': '状态',
        'waitDock.progress': '进度',
        'waitDock.kind': '类型',
        'waitDock.kindJob': '后台任务',
        'waitDock.kindWait': '条件等待',
        'waitDock.host': '机器',
        'waitDock.elapsed': '已等 {time}',
        'waitDock.eta': '剩余 ~{time}',
        'waitDock.noProgress': '无进度',
        'waitDock.started': '开始于',
        'waitDock.timeout': '超时上限',
        'waitDock.exitCode': '退出码',
        'waitDock.error': '错误',
        'waitDock.lastLine': '最后一行',
        'waitDock.samples': '进度采样',
        'waitDock.noSamples': '暂无采样',
        'waitDock.jobId': '任务 ID',
        'waitDock.condition': '条件',
        'waitDock.logPath': '日志',
        'waitDock.command': '命令',
        'waitDock.detail': '等待详情',
        'waitDock.footHint': '点击一行查看详情；结束的任务保留 10 秒',
      },
      en: {
        'toast.copyFailed': 'Copy failed',
        'toast.copyFailed.hint': 'The browser blocked clipboard access; select the text manually',
        'toast.copied': 'Copied to clipboard',
        'toast.connectionFailed': 'Connection failed',
        'toast.loadFailed': 'Could not load',
        'toast.openFailed': 'Could not open',
        'toast.actionFailed': 'Action failed',
        'toast.forwardOpened': 'Port forward opened',
        'toast.forwardClosed': 'Port forward closed',
        'toast.hostAdded': 'Host added',
        'toast.hostRemoved': 'Host removed',
        'toast.uploaded': 'Upload finished',
        'toast.downloaded': 'Download finished',
        'err.auth.title': 'Password required',
        'err.auth.hint': 'Connect from this panel once (tick “remember”), then retry',
        'err.portClosed.title': 'Nothing is listening on {target}',
        'err.portClosed.hint': 'Start the service on {host} first, or check the port',
        'err.refused.title': 'Connection refused',
        'err.refused.hint': 'Check that sshd is running and the port is right',
        'err.dns.title': 'Host name could not be resolved',
        'err.dns.hint': 'Check HostName in ~/.ssh/config or the manual host',
        'err.timeout.title': 'Connection timed out',
        'err.timeout.hint': 'Network or firewall problem',
        'err.unknownHost.title': 'Unknown machine',
        'err.unknownHost.hint': 'Check that it is still in ~/.ssh/config or the manual hosts',
        'err.permission.title': 'Permission denied',
        'err.permission.hint': 'The remote user cannot access that path or resource',
        'err.noSuchFile.title': 'File or directory not found',
        'err.noSuchFile.hint': 'Check the spelling, or refresh the folder and retry',
        'err.remote.title': 'Remote operation failed',
        'err.remote.hint': 'The original error is kept below',
        'err.generic.title': 'Something went wrong',
        'err.generic.hint': 'Check the connection and inputs, then retry',
        'toast.mkdirDone': 'Folder created',
        'toast.renamed': 'Renamed',
        'toast.chmodDone': 'Permissions updated',
        'toast.copiedPath': 'Remote path copied',
        'toast.deleted': 'Moved to the remote trash',
        'toast.discovered': '{count} new remote port(s) found',
        'toast.discovered.hint': 'Hit “Forward” on a port chip to open it locally',
        'toast.jobSuccess': 'Job finished',
        'toast.jobFailed': 'Job failed',
        'toast.jobEnded': 'Job ended',
        'toast.jobExitCode': 'exit {code}',
        'toast.jobSignal': 'signal {signal}',
        'toast.presetSaved': 'Auto-restore preset saved',
        'toast.presetKept': 'Forward preset saved',
        'toast.presetRemoved': 'Forward preset deleted',
        'toast.presetUpdated': 'Forward preset updated',
        'toast.diffNeedTarget': 'Choose the file to compare with',
        'toast.diffNeedTarget.hint': 'B can be another path on the same machine, or a local file',
        'toast.unsupportedFeature': 'This Presence version does not support that',
        'toast.unsupportedFeature.hint': 'Upgrade Presence to 0.18.0 and try again',
        'toast.notifyDenied': 'Browser notifications are off',
        'toast.notifyDenied.hint': 'Allow notifications in the address-bar permissions; in-app toasts still work',
        'waitDock.title': 'Waiting',
        'waitDock.expand': 'Expand the wait dock',
        'waitDock.collapse': 'Collapse',
        'waitDock.back': 'Back',
        'waitDock.running': '{count} waiting',
        'waitDock.donePill': '{count} finished',
        'waitDock.runningChip': '{count} running',
        'waitDock.finishedChip': '{count} finished',
        'waitDock.state.running': 'Running',
        'waitDock.state.done': 'Done',
        'waitDock.state.timeout': 'Timed out',
        'waitDock.state.error': 'Failed',
        'waitDock.status': 'Status',
        'waitDock.progress': 'Progress',
        'waitDock.kind': 'Kind',
        'waitDock.kindJob': 'Job',
        'waitDock.kindWait': 'Condition',
        'waitDock.host': 'Host',
        'waitDock.elapsed': 'Elapsed {time}',
        'waitDock.eta': '~{time} left',
        'waitDock.noProgress': 'No progress',
        'waitDock.started': 'Started',
        'waitDock.timeout': 'Timeout',
        'waitDock.exitCode': 'Exit code',
        'waitDock.error': 'Error',
        'waitDock.lastLine': 'Last line',
        'waitDock.samples': 'Progress samples',
        'waitDock.noSamples': 'No samples yet',
        'waitDock.jobId': 'Job ID',
        'waitDock.condition': 'Condition',
        'waitDock.logPath': 'Log',
        'waitDock.command': 'Command',
        'waitDock.detail': 'Wait details',
        'waitDock.footHint': 'Click a row for details; finished waits stay 10 s',
      },
    };

    function t(key, params = {}) {
      const template = MESSAGES[currentLocale()]?.[key] ?? MESSAGES.zh[key] ?? key;
      return template.replace(/\{(\w+)\}/gu, (match, name) => (params[name] === undefined ? match : String(params[name])));
    }

    function hasCjk(text) {
      return /[\u3400-\u9fff]/u.test(String(text ?? ''));
    }

    /**
     * Turn any backend string (mostly English ssh errors) into a locale-aware
     * title + hint, keeping the raw text as detail when it adds information.
     */
    function humanizeError(value) {
      if (value && typeof value === 'object' && value.title) {
        return { title: value.title, hint: value.hint ?? '', detail: value.detail ?? '' };
      }
      const raw = String(value ?? '').trim();
      if (!raw) return { title: t('err.generic.title'), hint: t('err.generic.hint'), detail: '' };
      const listening = /nothing is listening on (\S+) on (\S+)/u.exec(raw);
      if (listening) {
        return {
          title: t('err.portClosed.title', { target: listening[1] }),
          hint: t('err.portClosed.hint', { host: listening[2] }),
          detail: '',
        };
      }
      if (/authentication failed|no usable key|no password|password was supplied|Permission denied \(publickey|keyboard-interactive/iu.test(raw)) {
        return { title: t('err.auth.title'), hint: t('err.auth.hint'), detail: '' };
      }
      if (/connection refused|ECONNREFUSED/iu.test(raw)) {
        return { title: t('err.refused.title'), hint: t('err.refused.hint'), detail: raw };
      }
      if (/hostname could not be resolved|ENOTFOUND|EAI_AGAIN/iu.test(raw)) {
        return { title: t('err.dns.title'), hint: t('err.dns.hint'), detail: raw };
      }
      if (/timed out|ETIMEDOUT|timeout/iu.test(raw)) {
        return { title: t('err.timeout.title'), hint: t('err.timeout.hint'), detail: raw };
      }
      if (/no host "/u.test(raw) || /no host \[/u.test(raw)) {
        return { title: t('err.unknownHost.title'), hint: t('err.unknownHost.hint'), detail: raw };
      }
      if (/no such file|not found|does not exist/iu.test(raw)) {
        return { title: t('err.noSuchFile.title'), hint: t('err.noSuchFile.hint'), detail: raw };
      }
      if (/permission denied|EACCES|EPERM/iu.test(raw)) {
        return { title: t('err.permission.title'), hint: t('err.permission.hint'), detail: raw };
      }
      // Already Chinese (our own messages or translated backend text): keep it.
      if (hasCjk(raw)) return { title: raw.split('\n')[0], hint: '', detail: raw.includes('\n') ? raw : '' };
      return { title: t('err.remote.title'), hint: t('err.remote.hint'), detail: raw };
    }

    // ---------------------------------------------------------- toast store
    const NOTICE_DURATION = { success: 2600, info: 3600, warning: 5200, error: 7000 };
    const NOTICE_ACCENT = {
      success: 'var(--dsw-alias-state-success-primary)',
      info: 'var(--dsw-alias-state-business-primary)',
      warning: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    };
    const NOTICE_MAX = 5;
    const NOTICE_DEDUPE_MS = 8000;
    const noticeStore = { listeners: new Set(), nextId: 1, lastByKey: new Map() };

    /** Push a notice; `payload` is a string or {title, hint, detail}. */
    function pushNotice(kind, payload, options = {}) {
      if (payload === null || payload === undefined || payload === '') return;
      const id = noticeStore.nextId;
      noticeStore.nextId += 1;
      const info = typeof payload === 'string'
        ? humanizeError(payload)
        : { title: '', hint: '', detail: '', ...humanizeError(payload) };
      if (!info.title) return;
      const dedupeKey = options.dedupeKey ?? `${kind}:${info.title}`;
      const lastAt = noticeStore.lastByKey.get(dedupeKey) ?? 0;
      const now = Date.now();
      if (now - lastAt < NOTICE_DEDUPE_MS) return;
      noticeStore.lastByKey.set(dedupeKey, now);
      const notice = {
        id,
        kind,
        title: info.title,
        hint: info.hint ?? '',
        detail: info.detail ?? '',
        duration: options.duration ?? NOTICE_DURATION[kind] ?? 4000,
      };
      for (const listener of noticeStore.listeners) listener(notice);
    }

    const notifyError = (value) => pushNotice('error', value);
    const notifyWarning = (value) => pushNotice('warning', value);
    const notifySuccess = (title, options) => pushNotice('success', title, options);
    const notifyInfo = (title, options) => pushNotice('info', title, options);

    // --------------------------------------------------- desktop preferences
    // UI preferences live in localStorage like the rest of the panel; the job
    // watcher reads them on every event so a toggle takes effect immediately.
    const DESKTOP_NOTIFY_KEY = 'presence.desktopNotify';

    function readDesktopNotify() {
      try {
        const stored = window.localStorage.getItem(DESKTOP_NOTIFY_KEY);
        return stored === null || stored === undefined ? true : stored === '1';
      } catch {
        return true;
      }
    }

    function writeDesktopNotify(enabled) {
      try {
        window.localStorage.setItem(DESKTOP_NOTIFY_KEY, enabled ? '1' : '0');
      } catch {
        /* private mode / storage disabled: the toggle still applies to this page */
      }
    }

    function notificationPermission() {
      try {
        return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
      } catch {
        return 'unsupported';
      }
    }

    async function requestDesktopPermission() {
      try {
        if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') return 'unsupported';
        return await Notification.requestPermission();
      } catch {
        return 'denied';
      }
    }

    /** Best-effort OS notification; a browser restriction never breaks a toast. */
    function showDesktopNotification(title, body, tag) {
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const notice = new Notification(title, { body, tag, silent: false });
        notice.onclick = () => {
          try {
            window.focus();
          } catch {
            /* focus may be blocked, the notification still closes */
          }
          try {
            notice.close();
          } catch {
            /* already closed */
          }
        };
        setTimeout(() => {
          try {
            notice.close();
          } catch {
            /* already closed */
          }
        }, 10_000);
      } catch (error) {
        console.error('[presence] desktop notification failed', error);
      }
    }

    // ------------------------------------------------- job completion feed
    // `/state` carries the background-job registry. Poll it while the app is
    // open, remember the last state per job id, and notify on running -> exited.
    // The first successful poll only seeds the map, so jobs that finished
    // before the page opened never pop a toast after every reload.
    const JOB_POLL_MS = 4000;

    function startJobWatcher() {
      let previous = null;
      let timer = null;
      let disposed = false;
      let pollsWithoutJobs = 0;

      const describe = (job) => {
        const label = String(job.label ?? job.id ?? '').trim() || String(job.id ?? '');
        const host = String(job.host ?? '');
        const ok = isSuccessfulExit(job);
        const signal = job.exitSignal ?? job.signal ?? null;
        let exitText = '';
        if (typeof job.exitCode === 'number') exitText = t('toast.jobExitCode', { code: job.exitCode });
        else if (signal) exitText = t('toast.jobSignal', { signal: String(signal) });
        return { label, host, ok, exitText };
      };

      const announce = (job) => {
        const info = describe(job);
        const state = info.ok ? t('toast.jobSuccess') : t('toast.jobFailed');
        pushNotice(info.ok ? 'success' : 'error', {
          title: `${state}：${info.label || info.host}`,
          hint: [info.host, info.label].filter(Boolean).join(' · '),
          detail: info.exitText,
        }, { dedupeKey: `job:${job.id}`, duration: info.ok ? 5200 : 10_000 });
        if (readDesktopNotify()) {
          showDesktopNotification(
            `Presence · ${state}`,
            [info.label, info.host, info.exitText].filter(Boolean).join(' · '),
            `presence-job-${job.id}`,
          );
        }
      };

      const tick = async () => {
        if (disposed) return;
        try {
          const state = await request('/state');
          if (disposed) return;
          if (!Array.isArray(state?.jobs)) {
            // Older host without the `jobs` field: stop polling instead of
            // asking every 4 s for a feature that cannot work here.
            pollsWithoutJobs += 1;
            if (pollsWithoutJobs >= 2) {
              disposed = true;
              return;
            }
          } else {
            pollsWithoutJobs = 0;
            const result = detectJobExits(previous, state.jobs);
            previous = result.next;
            for (const job of result.exits) announce(job);
          }
        } catch {
          /* transient failures retry on the next tick */
        } finally {
          if (!disposed) timer = setTimeout(tick, JOB_POLL_MS);
        }
      };

      tick();
      return () => {
        disposed = true;
        if (timer) clearTimeout(timer);
        timer = null;
      };
    }

    function toastIcon(kind) {
      if (kind === 'success') return 'check';
      if (kind === 'info') return 'info';
      return 'alert';
    }

    function Toaster() {
      const [items, setItems] = useState([]);

      useEffect(() => {
        const timers = new Map();
        const dismiss = (id) => {
          setItems((current) => current.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
          const cleanup = setTimeout(() => {
            setItems((current) => current.filter((item) => item.id !== id));
          }, 220);
          timers.set(`cleanup:${id}`, cleanup);
        };
        const listener = (notice) => {
          setItems((current) => [...current.slice(-(NOTICE_MAX - 1)), notice]);
          timers.set(notice.id, setTimeout(() => dismiss(notice.id), notice.duration));
        };
        noticeStore.listeners.add(listener);
        return () => {
          noticeStore.listeners.delete(listener);
          for (const timer of timers.values()) clearTimeout(timer);
        };
      }, []);

      const dismissNow = (id) => {
        setItems((current) => current.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
        setTimeout(() => {
          setItems((current) => current.filter((item) => item.id !== id));
        }, 220);
      };

      if (items.length === 0) return null;
      return h('div', { className: 'dp-toasts', role: 'status', 'aria-live': 'polite' }, items.map((item) => h('div', {
        key: item.id,
        className: `dp-toast${item.leaving ? ' is-leaving' : ''}`,
        style: {
          '--dp-toast-accent': NOTICE_ACCENT[item.kind] ?? NOTICE_ACCENT.info,
          '--dp-toast-duration': `${item.duration}ms`,
        },
      }, [
        h('span', { key: 'icon', className: 'dp-toast-icon' }, h(Icon, { name: toastIcon(item.kind), size: 15 })),
        h('div', { key: 'body', className: 'dp-toast-body' }, [
          h('span', { key: 'title', className: 'dp-toast-title' }, item.title),
          item.hint ? h('span', { key: 'hint', className: 'dp-toast-hint' }, item.hint) : null,
          item.detail ? h('span', { key: 'detail', className: 'dp-toast-detail' }, item.detail) : null,
        ]),
        h('button', {
          key: 'close',
          type: 'button',
          className: 'dp-toast-close',
          title: currentLocale() === 'zh' ? '关闭' : 'Dismiss',
          onClick: () => dismissNow(item.id),
        }, h(Icon, { name: 'x', size: 13 })),
        h('div', { key: 'progress', className: 'dp-toast-progress' }, h('span', null)),
      ])));
    }

    /** Mount the single notification stack on document.body. */
    function mountToaster(ReactDOM) {
      try {
        const existing = document.getElementById('dsh-presence-toasts');
        if (existing) existing.remove();
        const container = document.createElement('div');
        container.id = 'dsh-presence-toasts';
        document.body.appendChild(container);
        const root = ReactDOM.createRoot(container);
        root.render(h(Toaster));
        return () => {
          try {
            root.unmount();
          } catch {
            /* already unmounted */
          }
          container.remove();
        };
      } catch (error) {
        console.error('[presence] toaster mount failed', error);
        return () => {};
      }
    }

    // ------------------------------------------------------- 0.21 wait dock
    // `presence_jobs wait` / `presence_wait` used to block as a black box. The
    // host now exposes GET /waits; one dock is mounted on document.body (like
    // the toaster) so waits are visible over the chat no matter which panel is
    // open. It stays a bottom-right pill until clicked.
    function waitStateInfo(wait, translate = t) {
      if (wait?.state === 'done') return { icon: 'check', className: 'is-done', label: translate('waitDock.state.done') };
      if (wait?.state === 'timeout') return { icon: 'clock', className: 'is-timeout', label: translate('waitDock.state.timeout') };
      if (wait?.state === 'error') return { icon: 'alert', className: 'is-error', label: translate('waitDock.state.error') };
      return { icon: 'clock', className: 'is-running', label: translate('waitDock.state.running') };
    }

    /** One wait row: state, label, host, elapsed, progress bar / ETA, last line. */
    function WaitDockRow({ wait, now, onOpen }) {
      const info = waitStateInfo(wait);
      const elapsed = formatElapsed(elapsedMs(wait, now));
      const ratio = progressRatio(wait.progress);
      const progressText = formatProgress(wait.progress);
      const eta = computeEta(wait.samples, {
        now,
        done: wait.progress.done,
        total: wait.progress.total,
      });
      const etaText = eta.reason === null && eta.etaMs !== null
        ? t('waitDock.eta', { time: formatDurationShort(eta.etaMs) })
        : null;
      return h('div', {
        className: `dp-wait-row ${info.className}`,
        role: 'button',
        tabIndex: 0,
        title: wait.label,
        onClick: onOpen,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onOpen();
        },
      }, [
        h('span', { key: 'state', className: 'dp-wait-state' },
          wait.state === 'running' ? h(Spinner, { size: 13 }) : h(Icon, { name: info.icon, size: 15 })),
        h('div', { key: 'main', className: 'dp-wait-main' }, [
          h('div', { key: 'top', className: 'dp-wait-top' }, [
            h('span', { key: 'label', className: 'dp-wait-label', title: wait.label }, wait.label),
            wait.host ? h('span', { key: 'host', className: 'dp-wait-host', title: wait.host }, wait.host) : null,
            h('span', {
              key: 'elapsed',
              className: 'dp-wait-elapsed',
              title: t('waitDock.elapsed', { time: elapsed }),
            }, elapsed),
          ]),
          ratio !== null
            ? h('div', { key: 'bar', className: 'dp-wait-bar' }, h('div', {
                className: 'dp-wait-bar-fill',
                style: { width: `${Math.round(ratio * 100)}%` },
              }))
            : null,
          h('div', { key: 'meta', className: 'dp-wait-meta' }, [
            progressText
              ? h('span', { key: 'progress', className: 'dp-wait-progress' }, progressText)
              : h('span', { key: 'noProgress', className: 'dp-wait-progress is-muted' }, t('waitDock.noProgress')),
            etaText
              ? h('span', { key: 'eta', className: 'dp-wait-eta' }, etaText)
              : h('span', { key: 'elapsedLong', className: 'dp-wait-eta' },
                  t('waitDock.elapsed', { time: formatDurationShort(elapsedMs(wait, now)) })),
            wait.state === 'running'
              ? null
              : h('span', { key: 'stateLabel', className: 'dp-wait-state-label' }, info.label),
          ]),
          wait.lastLine
            ? h('div', { key: 'line', className: 'dp-wait-line', title: wait.lastLine }, wait.lastLine)
            : null,
        ]),
      ]);
    }

    /** Detail view inside the card: metadata, full last line, sample list. */
    function WaitDockDetail({ wait, now }) {
      const info = waitStateInfo(wait);
      const elapsed = formatElapsed(elapsedMs(wait, now));
      const samples = reduceSamples(wait.samples, { maxPoints: 12, now });
      const kv = (key, label, value) => {
        if (value === null || value === undefined || value === '') return null;
        const text = String(value);
        return h('div', { key, className: 'dp-wait-kv' }, [
          h('span', { key: 'k', className: 'dp-wait-k' }, label),
          h('span', { key: 'v', className: 'dp-wait-v', title: text }, text),
        ]);
      };
      return [
        kv('status', t('waitDock.status'), info.label),
        kv('kind', t('waitDock.kind'), wait.kind === 'wait' ? t('waitDock.kindWait') : t('waitDock.kindJob')),
        kv('host', t('waitDock.host'), wait.host),
        kv('started', t('waitDock.started'), `${formatClock(wait.startedAt)} · ${t('waitDock.elapsed', { time: elapsed })}`),
        kv('progress', t('waitDock.progress'), formatProgress(wait.progress)),
        kv('timeout', t('waitDock.timeout'), wait.timeoutMs !== null ? formatDurationShort(wait.timeoutMs) : null),
        kv('jobId', t('waitDock.jobId'), wait.meta.jobId),
        kv('condition', t('waitDock.condition'), wait.meta.condition),
        kv('logPath', t('waitDock.logPath'), wait.meta.logPath),
        kv('command', t('waitDock.command'), wait.meta.command),
        kv('exitCode', t('waitDock.exitCode'), wait.exitCode),
        kv('error', t('waitDock.error'), wait.error),
        wait.lastLine
          ? h('div', { key: 'lastLineLabel', className: 'dp-wait-sub' }, t('waitDock.lastLine'))
          : null,
        wait.lastLine
          ? h('pre', { key: 'lastLine', className: 'dp-wait-monoline' }, wait.lastLine)
          : null,
        h('div', { key: 'samplesLabel', className: 'dp-wait-sub' }, t('waitDock.samples')),
        samples.length === 0
          ? h('div', { key: 'noSamples', className: 'dp-wait-sub' }, t('waitDock.noSamples'))
          : h('div', { key: 'samples', className: 'dp-wait-samples' }, samples.map((sample, index) => h('div', {
              key: `${sample.at}#${index}`,
              className: 'dp-wait-sample',
            }, [
              h('span', { key: 'value' }, `${sample.done ?? '—'} / ${sample.total ?? '—'}`),
              h('span', { key: 'clock' }, formatClock(sample.at)),
            ]))),
      ].filter(Boolean);
    }

    /**
     * Floating wait dock. Polls GET /waits at 1.5 s while expanded and 5 s while
     * collapsed/idle; a 404 from an older host hides it for the rest of the
     * session. Finished entries stay 10 s (client-side) and then vanish.
     */
    function WaitDock() {
      const [waits, setWaits] = useState([]);
      const [now, setNow] = useState(() => Date.now());
      const [expanded, setExpanded] = useState(false);
      const [detailId, setDetailId] = useState(null);
      const [supported, setSupported] = useState(true);
      const [error, setError] = useState('');
      const unsupportedRef = useRef(false);
      const dockRef = useRef(null);
      const lastFetchRef = useRef(0);

      // Presentation is pure, so compute it before the effects: the polling
      // interval depends on hidden/collapsed/expanded, and expanding must start
      // the 1.5 s loop immediately instead of waiting for the 5 s tick.
      const presentation = dockPresentation({ expanded, waits, now, holdMs: FINISHED_HOLD_MS });
      const mode = presentation.mode;

      useEffect(() => {
        if (!supported) return undefined;
        let disposed = false;
        let timer = null;
        // Per-effect-instance guard: a restart (expand/collapse) must not leave
        // the new loop waiting for the previous instance's request.
        let inflight = false;
        const schedule = (ms) => {
          if (disposed) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(tick, ms);
        };
        async function tick() {
          if (disposed || inflight) return;
          inflight = true;
          lastFetchRef.current = Date.now();
          try {
            const data = await request('/waits');
            if (disposed) return;
            const payload = normalizeWaitsPayload(data, Date.now());
            setWaits(payload.waits);
            setNow(payload.now || Date.now());
            setError('');
          } catch (err) {
            if (disposed) return;
            // 404/405 is the documented "old host"; the packaged desktop shell
            // answers unknown plugin routes with 401, which means the same here.
            if (isMissingEndpointError(err.message) || /HTTP 401\b/u.test(err.message)) {
              // Older host: no /waits route. Hide the dock and stop polling.
              unsupportedRef.current = true;
              setSupported(false);
              setWaits([]);
              return;
            }
            setError(err.message);
          } finally {
            inflight = false;
            if (!disposed && !unsupportedRef.current) {
              // 1.5 s while the card is open; 5 s collapsed, idle or hidden.
              schedule(mode === 'expanded' ? POLL_EXPANDED_MS : POLL_COLLAPSED_MS);
            }
          }
        }
        // Resume immediately when the page becomes visible again (a hidden tab
        // throttles timers, so the dock may be stale on return).
        const wake = () => {
          if (disposed || document.visibilityState !== 'visible') return;
          if (Date.now() - lastFetchRef.current < 900) return;
          if (timer) clearTimeout(timer);
          tick();
        };
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('focus', wake);
        tick();
        return () => {
          disposed = true;
          if (timer) clearTimeout(timer);
          timer = null;
          document.removeEventListener('visibilitychange', wake);
          window.removeEventListener('focus', wake);
        };
      }, [supported, mode]);

      // Smooth the elapsed mm:ss while the card is open: /waits is polled every
      // 1.5 s, the local clock ticks every second in between.
      useEffect(() => {
        if (!expanded) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [expanded]);

      // Esc leaves the detail view first, then collapses the card.
      useEffect(() => {
        if (!expanded) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          if (detailId) setDetailId(null);
          else setExpanded(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [expanded, detailId]);

      // Let the toast stack sit above the dock: its CSS bottom offset reads
      // --dp-dock-height, updated on expand/collapse and whenever the card
      // changes size (new rows, detail view, window resize).
      const reportHeight = useCallback(() => {
        try {
          const node = dockRef.current;
          const height = node ? Math.ceil(node.getBoundingClientRect().height) : 0;
          document.documentElement.style.setProperty('--dp-dock-height', `${height}px`);
        } catch {
          /* document is going away during unmount */
        }
      }, []);

      useEffect(() => {
        reportHeight();
        if (mode === 'hidden') return undefined;
        const node = dockRef.current;
        if (!node) return undefined;
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(() => reportHeight());
          observer.observe(node);
          return () => observer.disconnect();
        }
        window.addEventListener('resize', reportHeight);
        return () => window.removeEventListener('resize', reportHeight);
      }, [reportHeight, mode, detailId, presentation.visible.length]);

      if (!supported || mode === 'hidden') return null;

      const detail = detailId ? presentation.visible.find((wait) => wait.id === detailId) : null;

      if (!expanded) {
        const pill = pillLabelText(presentation.visible);
        return h('div', { ref: dockRef, className: 'dp-wait-dock' }, h('button', {
          key: 'pill',
          type: 'button',
          className: 'dp-wait-pill',
          title: t('waitDock.expand'),
          onClick: () => setExpanded(true),
        }, [
          h('span', { key: 'icon', className: 'dp-wait-pill-icon' }, '⏳'),
          presentation.showSpinner ? h(Spinner, { key: 'spin', size: 12 }) : null,
          h('span', { key: 'count', className: 'dp-wait-pill-count' },
            presentation.running > 0
              ? t('waitDock.running', { count: presentation.running })
              : t('waitDock.donePill', { count: presentation.finished })),
          pill ? h('span', { key: 'label', className: 'dp-wait-pill-label' }, `· ${pill.label}`) : null,
        ]));
      }

      return h('div', { ref: dockRef, className: 'dp-wait-dock' }, h('div', {
        key: 'card',
        className: 'dp-wait-card',
        role: 'status',
        'aria-live': 'polite',
      }, [
        h('div', { key: 'head', className: 'dp-wait-head' }, [
          h('span', { key: 'icon', className: 'dp-wait-head-icon' },
            presentation.showSpinner ? h(Spinner, { size: 14 }) : h(Icon, { name: 'clock', size: 15 })),
          h('span', { key: 'title', className: 'dp-wait-title' }, detail ? t('waitDock.detail') : t('waitDock.title')),
          h('span', { key: 'running', className: 'dp-wait-chip' }, t('waitDock.runningChip', { count: presentation.running })),
          presentation.finished > 0
            ? h('span', { key: 'finished', className: 'dp-wait-chip' }, t('waitDock.finishedChip', { count: presentation.finished }))
            : null,
          h('div', { key: 'spacer', style: { flex: 1 } }),
          detail
            ? h('button', {
                key: 'back',
                type: 'button',
                className: 'dp-wait-btn',
                onClick: () => setDetailId(null),
              }, `← ${t('waitDock.back')}`)
            : null,
          h('button', {
            key: 'collapse',
            type: 'button',
            className: 'dp-wait-btn',
            title: t('waitDock.collapse'),
            onClick: () => {
              setDetailId(null);
              setExpanded(false);
            },
          }, h(Icon, { name: 'chevron', size: 14, style: { transform: 'rotate(-90deg)' } })),
        ]),
        error ? h('div', { key: 'error', className: 'dp-wait-error' }, error) : null,
        detail
          ? h('div', { key: 'detail', className: 'dp-wait-detail' }, h(WaitDockDetail, { wait: detail, now }))
          : h('div', { key: 'list', className: 'dp-wait-list' }, presentation.visible.map((wait) => h(WaitDockRow, {
              key: wait.id,
              wait,
              now,
              onOpen: () => setDetailId(wait.id),
            }))),
        detail ? null : h('div', { key: 'foot', className: 'dp-wait-foot' }, t('waitDock.footHint')),
      ]));
    }

    /** Mount the floating wait dock on document.body; disposed with the plugin. */
    function mountWaitDock(ReactDOM) {
      try {
        const existing = document.getElementById('dsh-presence-wait-dock');
        if (existing) existing.remove();
        const container = document.createElement('div');
        container.id = 'dsh-presence-wait-dock';
        document.body.appendChild(container);
        const root = ReactDOM.createRoot(container);
        root.render(h(WaitDock));
        return () => {
          try {
            root.unmount();
          } catch {
            /* already unmounted */
          }
          container.remove();
          try {
            document.documentElement.style.removeProperty('--dp-dock-height');
          } catch {
            /* document is going away */
          }
        };
      } catch (error) {
        console.error('[presence] wait dock mount failed', error);
        return () => {};
      }
    }

    const C = {
      soft: 'var(--dsw-alias-bg-module-platform)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    };

    // Interaction states (hover / active / focus / motion) need real CSS: inline
    // styles cannot express pseudo-classes. One prefixed stylesheet is injected
    // once; every colour comes from the theme tokens so light and dark both work.
    const STYLE_ID = 'dsh-presence-ui';
    const CSS = `
      /* OpenDesign token contract applied on top of the DSH theme:
         motion-fast 130ms / motion-base 220ms / ease-standard cubic-bezier(.2,0,0,1);
         radii 8/12/20; focus ring 4px accent at 28%; accent hover/active via color-mix.
         Colour still comes from --dsw-alias-* so light and dark both stay correct. */
      .dp-ui {
        --dp-fast: 130ms;
        --dp-base: 220ms;
        --dp-ease: cubic-bezier(0.2, 0, 0, 1);
        --dp-radius-sm: 8px;
        --dp-radius-md: 12px;
        --dp-radius-lg: 20px;
        --dp-accent: var(--dsw-alias-brand-primary);
        --dp-accent-hover: color-mix(in oklab, var(--dp-accent), black 8%);
        --dp-accent-active: color-mix(in oklab, var(--dp-accent), black 14%);
        --dp-ring: 0 0 0 4px color-mix(in srgb, var(--dp-accent) 28%, transparent);
        --dp-elev-ring: 0 0 0 1px var(--dsw-alias-border-l1);
      }
      .dp-ui *, .dp-ui *::before, .dp-ui *::after { box-sizing: border-box; }

      /* ---- buttons: hover lifts, active presses, focus shows a 4px ring ---- */
      .dp-btn {
        font: inherit; font-size: 13px; line-height: 20px; padding: 5px 14px;
        border-radius: var(--dp-radius-sm); white-space: nowrap; cursor: pointer;
        border: 1px solid var(--dsw-alias-border-l1);
        background: transparent; color: var(--dsw-alias-label-primary);
        transition:
          background-color var(--dp-fast) var(--dp-ease),
          border-color var(--dp-fast) var(--dp-ease),
          color var(--dp-fast) var(--dp-ease),
          box-shadow var(--dp-base) var(--dp-ease),
          transform var(--dp-fast) var(--dp-ease);
      }
      .dp-btn:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover);
        border-color: var(--dsw-alias-border-l3);
        transform: translateY(-1px);
        box-shadow: var(--dp-elev-ring);
      }
      .dp-btn:active:not(:disabled) { transform: translateY(0) scale(.98); box-shadow: none; }
      .dp-btn:focus-visible { outline: none; box-shadow: var(--dp-ring); }
      .dp-btn:disabled { opacity: .45; cursor: not-allowed; }
      .dp-btn--sm { font-size: 12px; padding: 3px 10px; }

      .dp-btn--primary {
        border-color: transparent; background: var(--dp-accent); color: #fff;
        box-shadow: 0 1px 2px rgba(0, 0, 0, .14);
      }
      .dp-btn--primary:hover:not(:disabled) {
        background: var(--dp-accent-hover); border-color: transparent;
        transform: translateY(-1px);
        box-shadow: 0 4px 14px rgba(0, 0, 0, .2);
      }
      .dp-btn--primary:active:not(:disabled) { background: var(--dp-accent-active); }
      .dp-btn--primary:focus-visible { box-shadow: var(--dp-ring); }

      /* ---- card: ring at rest, soft raised shadow on hover ---- */
      .dp-card {
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: var(--dp-radius-lg);
        overflow: hidden;
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: var(--dp-elev-ring);
        transition:
          box-shadow var(--dp-base) var(--dp-ease),
          border-color var(--dp-base) var(--dp-ease);
        animation: dp-in var(--dp-base) var(--dp-ease) both;
      }
      .dp-card:hover { box-shadow: 0 8px 28px rgba(0, 0, 0, .1); border-color: var(--dsw-alias-border-l2); }
      @keyframes dp-in {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: none; }
      }

      /* ---- list rows ---- */
      .dp-row {
        display: flex; width: 100%; align-items: center; gap: 10px;
        padding: 8px 12px; border: 0; border-radius: var(--dp-radius-md);
        background: transparent; color: var(--dsw-alias-label-primary);
        font: inherit; text-align: left; cursor: pointer;
        transition:
          background-color var(--dp-fast) var(--dp-ease),
          transform var(--dp-fast) var(--dp-ease);
      }
      .dp-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .dp-row:active:not(:disabled) { transform: scale(.995); }
      .dp-row:focus-visible { outline: none; box-shadow: var(--dp-ring); }
      .dp-row:disabled { cursor: not-allowed; }

      .dp-icon {
        width: 26px; height: 26px; border-radius: var(--dp-radius-sm); flex: 0 0 auto;
        background: var(--dsw-alias-bg-module-platform);
        display: grid; place-items: center; font-size: 13px;
        transition: background-color var(--dp-fast) var(--dp-ease);
      }
      .dp-row:hover:not(:disabled) .dp-icon { background: var(--dsw-alias-bg-base); }

      /* ---- breadcrumbs ---- */
      .dp-crumb {
        border: 0; background: transparent; padding: 3px 8px;
        border-radius: var(--dp-radius-sm); font: inherit; font-size: 12px;
        color: var(--dsw-alias-label-secondary); cursor: pointer;
        transition:
          background-color var(--dp-fast) var(--dp-ease),
          color var(--dp-fast) var(--dp-ease);
      }
      .dp-crumb:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
      }
      .dp-crumb:focus-visible { outline: none; box-shadow: var(--dp-ring); }
      .dp-crumb--current { color: var(--dsw-alias-label-primary); font-weight: 600; cursor: default; }
      .dp-crumb--current:hover { background: transparent; }

      /* ---- icon button (back arrow) ---- */
      .dp-iconbtn {
        width: 28px; height: 28px; border-radius: var(--dp-radius-sm); flex: 0 0 auto;
        border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
        font-size: 13px; line-height: 28px; cursor: pointer;
        transition:
          background-color var(--dp-fast) var(--dp-ease),
          color var(--dp-fast) var(--dp-ease),
          transform var(--dp-fast) var(--dp-ease);
      }
      .dp-iconbtn:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
      }
      .dp-iconbtn:active:not(:disabled) { transform: scale(.92); }
      .dp-iconbtn:focus-visible { outline: none; box-shadow: var(--dp-ring); }

      /* ---- filter input ---- */
      .dp-input {
        width: 100%; padding: 6px 10px; font-size: 12px;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-module-platform);
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dp-radius-sm); outline: none;
        transition:
          border-color var(--dp-fast) var(--dp-ease),
          box-shadow var(--dp-fast) var(--dp-ease),
          background-color var(--dp-fast) var(--dp-ease);
      }
      .dp-input::placeholder { color: var(--dsw-alias-label-secondary); }
      .dp-input:hover { border-color: var(--dsw-alias-border-l3); }
      .dp-input:focus { border-color: var(--dp-accent); box-shadow: var(--dp-ring); }

      /* ---- workspace rows ---- */
      .dp-ws {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 12px; border-radius: var(--dp-radius-md);
        transition: background-color var(--dp-fast) var(--dp-ease);
      }
      .dp-ws:hover { background: var(--dsw-alias-interactive-bg-hover); }

      /* ---- Presence settings page ---- */
      .dp-settings-page { display: flex; flex-direction: column; gap: 12px; }
      .dp-page-head { display: flex; flex-direction: column; gap: 5px; padding: 2px 0 2px; }
      .dp-page-title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .dp-page-title { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.3; white-space: nowrap; }
      .dp-page-subtitle { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.55; }
      .dp-settings-body { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
      .dp-section {
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dp-radius-lg);
        background: var(--dsw-alias-bg-layer-1); padding: 12px 14px;
      }
      .dp-section-head { display: flex; align-items: center; gap: 8px; padding: 0 2px 8px; min-width: 0; }
      .dp-section-title { font-size: 13px; font-weight: 600; white-space: nowrap; }
      .dp-section-hint {
        color: var(--dsw-alias-label-tertiary); font-size: 11.5px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        margin-left: auto; min-width: 0;
      }
      .dp-host-group {
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dp-radius-md);
        background: var(--dsw-alias-bg-layer-1); overflow: hidden;
      }
      .dp-host-group + .dp-host-group { margin-top: 10px; }
      .dp-host-head {
        padding: 10px 12px 9px;
        background: color-mix(in srgb, var(--dsw-alias-bg-module-platform) 60%, transparent);
      }
      .dp-host-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .dp-host-alias {
        font-weight: 600; font-size: 13px; line-height: 1.35;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        min-width: 0; flex: 0 1 auto;
      }
      .dp-host-meta {
        margin-top: 3px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 1.4;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
      }
      .dp-state-chip {
        display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto;
        white-space: nowrap; font-size: 11.5px; color: var(--dsw-alias-label-secondary);
      }
      .dp-state-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
      .dp-ws-list { display: flex; flex-direction: column; }
      .dp-ws-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; min-width: 0; }
      .dp-ws-row + .dp-ws-row { border-top: 1px solid var(--dsw-alias-border-l2); }
      .dp-ws-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dp-ws-icon {
        width: 26px; height: 26px; border-radius: 8px; flex: 0 0 auto;
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary);
      }
      .dp-ws-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
      .dp-ws-name {
        display: flex; align-items: center; gap: 6px; min-width: 0;
        font-size: 13px; font-weight: 500; line-height: 1.35;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .dp-ws-path {
        font-size: 11.5px; line-height: 1.4; color: var(--dsw-alias-label-tertiary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
      }
      .dp-ws-actions {
        display: flex; align-items: center; gap: 6px; flex: 0 0 auto; opacity: .78;
        transition: opacity var(--dp-fast) var(--dp-ease);
      }
      .dp-ws-row:hover .dp-ws-actions { opacity: 1; }
      .dp-empty {
        border: 1px dashed var(--dsw-alias-border-l3); border-radius: var(--dp-radius-md);
        padding: 18px 16px; text-align: center; color: var(--dsw-alias-label-secondary);
        font-size: 12.5px; line-height: 1.7;
      }
      .dp-setting-row { display: flex; align-items: flex-start; gap: 12px; padding: 4px 2px 6px; }
      .dp-setting-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 auto; }
      .dp-setting-title { font-size: 13px; font-weight: 500; }
      .dp-setting-hint { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); line-height: 1.55; }
      .dp-btn--ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
      .dp-btn--ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: transparent; }
      .dp-btn--ghost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .dp-chip--accent {
        background: color-mix(in srgb, var(--dp-accent) 14%, transparent);
        color: var(--dp-accent);
      }

      @media (prefers-reduced-motion: reduce) {
        .dp-btn, .dp-row, .dp-crumb, .dp-iconbtn, .dp-input, .dp-ws, .dp-card {
          transition: none; animation: none;
        }
        .dp-btn:hover:not(:disabled) { transform: none; }
      }

      /* loading spinner (settings panel + remote file pane) */
      @keyframes dp-spin { to { transform: rotate(360deg); } }
      .dp-spin {
        border-radius: 50%;
        border: 2px solid var(--dsw-alias-border-l1);
        border-top-color: var(--dsw-alias-brand-primary);
        animation: dp-spin .8s linear infinite;
      }

      /* ---------------------------------------------------- notifications */
      .dp-toasts {
        position: fixed; right: 16px; bottom: calc(16px + var(--dp-dock-height, 0px)); z-index: 2147483000;
        display: flex; flex-direction: column-reverse; gap: 8px;
        width: min(380px, calc(100vw - 32px));
        pointer-events: none;
      }
      .dp-toast {
        pointer-events: auto;
        display: flex; align-items: flex-start; gap: 10px;
        padding: 10px 12px 10px 14px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: 0 12px 32px rgba(0, 0, 0, .16), 0 1px 2px rgba(0, 0, 0, .06);
        animation: dp-toast-in 220ms var(--dp-ease, cubic-bezier(.4,0,.2,1)) both;
        position: relative; overflow: hidden;
      }
      .dp-toast.is-leaving { animation: dp-toast-out 170ms var(--dp-ease, cubic-bezier(.4,0,.2,1)) both; }
      .dp-toast::before {
        content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
        background: var(--dp-toast-accent, var(--dsw-alias-label-secondary));
      }
      .dp-toast-icon { color: var(--dp-toast-accent); margin-top: 1px; display: inline-flex; }
      .dp-toast-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .dp-toast-title { font-size: 12.5px; font-weight: 600; line-height: 17px; }
      .dp-toast-hint { font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
      .dp-toast-detail {
        font-size: 10.5px; line-height: 15px; color: var(--dsw-alias-label-tertiary);
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
        overflow-wrap: anywhere; max-height: 45px; overflow: hidden;
      }
      .dp-toast-close {
        flex: 0 0 auto; width: 20px; height: 20px; margin-top: -1px;
        display: grid; place-items: center; padding: 0;
        border: 0; border-radius: 999px; background: transparent;
        color: var(--dsw-alias-label-tertiary); cursor: pointer;
        transition: background-color var(--dp-fast, .1s) var(--dp-ease, ease);
      }
      .dp-toast-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .dp-toast-close:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
      .dp-toast-progress {
        position: absolute; left: 3px; right: 0; bottom: 0; height: 2px;
        background: var(--dsw-alias-bg-module-platform);
      }
      .dp-toast-progress > span {
        display: block; height: 100%; width: 100%;
        background: var(--dp-toast-accent);
        opacity: .5;
        transform-origin: left center;
        animation: dp-toast-timer var(--dp-toast-duration, 6s) linear both;
      }
      @keyframes dp-toast-in {
        from { opacity: 0; transform: translateY(10px) scale(.98); }
        to { opacity: 1; transform: none; }
      }
      @keyframes dp-toast-out {
        from { opacity: 1; transform: none; }
        to { opacity: 0; transform: translateY(6px) scale(.985); }
      }
      @keyframes dp-toast-timer {
        from { transform: scaleX(1); }
        to { transform: scaleX(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .dp-toast, .dp-toast.is-leaving { animation-duration: 1ms; }
        .dp-toast-progress > span { animation-duration: 1ms; }
      }

      /* -------------------------------------------------- remote file pane
         Uses the harness theme's own interaction tokens (bg-layer-1 and
         bg-layer-2 are the SAME colour in the light theme, which is why hover
         was invisible), plus the theme motion/radius tokens. */
      .dp-pane {
        display: flex; flex-direction: column; height: 100%; min-height: 0;
        color: var(--dsw-alias-label-primary); font-size: 13px; position: relative;
        background: transparent;
        --dp-fast: var(--ds-transition-duration-fast, .1s);
        --dp-ease: var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1));
      }
      .dp-pane, .dp-pane .dp-entry, .dp-pane .dp-toolbar, .dp-pane .dp-path,
      .dp-pane .dp-columns, .dp-pane .dp-filter, .dp-pane .dp-crumbs {
        -webkit-user-select: none; user-select: none;
      }
      .dp-pane .dp-code, .dp-pane .dp-plain, .dp-pane .dp-input,
      .dp-pane .dp-modal-path, .dp-pane select { -webkit-user-select: text; user-select: text; }

      /* toolbar */
      .dp-toolbar {
        display: flex; align-items: center; gap: 4px;
        padding: 6px 8px; min-height: 40px; box-sizing: border-box;
        border-bottom: 1px solid var(--dsw-alias-border-l2);
        flex: 0 0 auto;
      }
      .dp-toolbar-icon { color: var(--dsw-alias-label-tertiary); display: inline-flex; }
      .dp-select {
        height: 28px; padding: 0 8px; max-width: 136px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 8px);
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 12px; outline: none; cursor: pointer;
        transition: border-color var(--dp-fast) var(--dp-ease), box-shadow var(--dp-fast) var(--dp-ease);
      }
      .dp-select:hover { border-color: var(--dsw-alias-border-l3); }
      .dp-select:focus-visible { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent); }

      .dp-tool {
        display: inline-flex; align-items: center; gap: 6px;
        height: 28px; padding: 0 10px;
        border: 1px solid transparent; border-radius: var(--dsw-radius-sm, 8px);
        background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 12px; line-height: 1; cursor: pointer;
        transition: background-color var(--dp-fast) var(--dp-ease),
          color var(--dp-fast) var(--dp-ease);
      }
      .dp-tool:hover {
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
      }
      .dp-tool:active { background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover) 70%, var(--dsw-alias-border-l3)); }
      .dp-tool:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
      .dp-tool--primary {
        border-color: var(--dsw-alias-border-l3);
        background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary));
        color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base));
      }
      .dp-tool--primary:hover {
        background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary));
        color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base));
        filter: brightness(1.04);
      }

      /* path bar */
      .dp-path {
        display: flex; align-items: center; gap: 1px; flex-wrap: wrap;
        padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2);
        flex: 0 0 auto;
      }
      .dp-path-part { display: inline-flex; align-items: center; }
      .dp-pane .dp-path-sep { color: var(--dsw-alias-label-tertiary); display: inline-flex; margin: 0 1px; }
      .dp-pane .dp-crumb {
        border: 1px solid transparent; background: transparent;
        padding: 2px 8px; border-radius: 999px; max-width: 160px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font: inherit; font-size: 12px; line-height: 18px;
        color: var(--dsw-alias-label-secondary); cursor: pointer;
        transition: background-color var(--dp-fast) var(--dp-ease),
          color var(--dp-fast) var(--dp-ease);
      }
      .dp-pane .dp-crumb:hover {
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-primary);
      }
      .dp-pane .dp-crumb:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
      .dp-crumb--current {
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-primary);
        font-weight: 500; cursor: default;
      }
      .dp-crumb--current:hover { background: var(--dsw-alias-bg-module-platform); }

      /* filter */
      .dp-filter { position: relative; padding: 6px 8px; flex: 0 0 auto; border-bottom: 1px solid var(--dsw-alias-border-l2); }
      .dp-filter-icon {
        position: absolute; left: 18px; top: 50%; transform: translateY(-50%);
        color: var(--dsw-alias-label-tertiary); display: inline-flex; pointer-events: none;
      }
      .dp-pane .dp-input {
        width: 100%; height: 28px; box-sizing: border-box; padding: 0 10px;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 8px);
        background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 12px; outline: none;
        transition: border-color var(--dp-fast) var(--dp-ease), box-shadow var(--dp-fast) var(--dp-ease);
      }
      .dp-filter .dp-input { padding-left: 28px; }
      .dp-pane .dp-input::placeholder { color: var(--dsw-alias-label-tertiary); }
      .dp-pane .dp-input:hover { border-color: var(--dsw-alias-border-l3); }
      .dp-pane .dp-input:focus-visible {
        border-color: var(--dsw-alias-state-business-primary);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent);
      }

      /* column header + list */
      .dp-columns {
        display: flex; align-items: center; gap: 10px;
        padding: 6px 10px 4px 44px;
        font-size: 11px; color: var(--dsw-alias-label-tertiary);
        border-bottom: 1px solid var(--dsw-alias-border-l2);
        flex: 0 0 auto;
      }
      .dp-col-name { flex: 1; min-width: 0; }
      .dp-col-size { width: 64px; flex: 0 0 auto; text-align: right; }
      .dp-col-time { width: 76px; flex: 0 0 auto; text-align: right; }
      .dp-col-actions { width: 78px; flex: 0 0 auto; }

      .dp-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 6px 18px; }
      .dp-loading { display: flex; justify-content: center; padding: 32px 0; }

      .dp-entry {
        display: flex; align-items: center; gap: 10px; width: 100%;
        min-height: 34px; padding: 4px 8px; box-sizing: border-box;
        border: 0; border-radius: var(--dsw-radius-sm, 8px);
        background: transparent; color: inherit; font: inherit;
        text-align: left; cursor: default;
        transition: background-color var(--dp-fast) var(--dp-ease),
          box-shadow var(--dp-fast) var(--dp-ease);
      }
      .dp-entry:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dp-entry.is-selected { background: var(--dsw-alias-bg-multi-select); }
      .dp-entry:focus-visible {
        outline: 2px solid var(--dsw-alias-state-business-primary);
        outline-offset: -2px;
      }
      .dp-entry:active { background: var(--dsw-alias-bg-module-platform); }

      .dp-tile {
        width: 26px; height: 26px; flex: 0 0 auto;
        display: grid; place-items: center;
        border-radius: var(--dsw-radius-xs, 4px);
        color: var(--dsw-alias-label-tertiary);
        background: transparent;
        transition: background-color var(--dp-fast) var(--dp-ease), color var(--dp-fast) var(--dp-ease);
      }
      .dp-tile--dir { color: var(--dsw-alias-state-business-primary); }
      .dp-tile--image { color: var(--dsw-alias-state-success-primary); }
      .dp-entry:hover .dp-tile { background: var(--dsw-alias-bg-module-platform); }
      .dp-entry:hover .dp-tile--dir { color: var(--dsw-alias-state-business-primary); }

      .dp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
      .dp-meta {
        color: var(--dsw-alias-label-tertiary); font-size: 11.5px;
        flex: 0 0 auto; font-variant-numeric: tabular-nums; text-align: right;
      }
      .dp-entry .dp-col-size, .dp-entry .dp-col-time { line-height: 20px; }

      .dp-factions {
        display: flex; gap: 2px; width: 78px; flex: 0 0 auto; justify-content: flex-end;
        opacity: 0; transition: opacity var(--dp-fast) var(--dp-ease);
      }
      .dp-entry:hover .dp-factions, .dp-entry:focus-within .dp-factions, .dp-entry.is-selected .dp-factions { opacity: 1; }
      .dp-pane .dp-iconbtn {
        width: 24px; height: 24px; padding: 0;
        display: grid; place-items: center;
        border: 0; border-radius: var(--dsw-radius-xs, 4px);
        background: transparent; color: var(--dsw-alias-label-secondary);
        cursor: pointer;
        transition: background-color var(--dp-fast) var(--dp-ease), color var(--dp-fast) var(--dp-ease);
      }
      .dp-pane .dp-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .dp-pane .dp-iconbtn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }

      .dp-empty {
        display: flex; flex-direction: column; align-items: center; gap: 10px;
        padding: 44px 16px; color: var(--dsw-alias-label-tertiary); font-size: 12px;
      }
      .dp-empty-icon {
        width: 40px; height: 40px; display: grid; place-items: center;
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-secondary);
      }
      .dp-empty-hint { font-size: 11.5px; line-height: 1.7; max-width: 250px; text-align: center; }

      /* ------------------------------------------------- port forwards */
      .dp-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      .dp-field--host { flex: 1 1 120px; }
      .dp-field--port { flex: 0 0 92px; }
      .dp-field-label {
        font-size: 10.5px; line-height: 14px; letter-spacing: .01em;
        color: var(--dsw-alias-label-tertiary);
      }
      .dp-form-hint {
        flex: 1 1 100%; font-size: 11px; line-height: 16px;
        color: var(--dsw-alias-label-tertiary);
      }
      .dp-form-row { display: flex; align-items: flex-end; gap: 6px; flex: 1 1 100%; }
      .dp-banner-title { font-weight: 600; }
      .dp-banner-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .dp-banner-hint { font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
      .dp-banner-detail {
        font-size: 10.5px; line-height: 15px; color: var(--dsw-alias-label-tertiary);
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
        overflow-wrap: anywhere;
      }
      .dp-form {
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        padding: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2);
        flex: 0 0 auto;
      }
      .dp-pane .dp-form .dp-select { flex: 1 1 100%; max-width: none; }
      .dp-pane .dp-form .dp-input { width: auto; padding: 0 10px; }
      .dp-pane .dp-form .dp-input--host { flex: 1 1 120px; }
      .dp-pane .dp-form .dp-input--port { flex: 0 0 76px; }
      .dp-pane .dp-form .dp-tool { flex: 0 0 auto; }
      .dp-pane .dp-form .dp-field .dp-input { width: 100%; }
      .dp-form .dp-tool[disabled] { opacity: .45; cursor: default; }
      .dp-mono {
        font-family: var(--ds-font-family-code, "Cascadia Code", Consolas, ui-monospace, monospace);
        font-variant-numeric: tabular-nums;
      }
      .dp-link { color: var(--dsw-alias-state-business-primary); text-decoration: none; }
      .dp-link:hover { text-decoration: underline; }

      .dp-group { margin-top: 10px; }
      .dp-group-head {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 8px 4px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px;
      }
      .dp-group-name { color: var(--dsw-alias-label-primary); font-weight: 600; font-size: 12px; }
      .dp-group-chip {
        padding: 0 7px; border-radius: 999px; line-height: 16px;
        background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary);
        font-size: 10.5px;
      }
      .dp-entry--tunnel { min-height: 42px; }
      .dp-tunnel-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      .dp-tunnel-route { font-size: 12.5px; }
      .dp-tunnel-arrow { color: var(--dsw-alias-label-tertiary); margin: 0 4px; }
      .dp-tunnel-url {
        display: block; min-width: 0; font-size: 11.5px;
        color: var(--dsw-alias-state-business-primary);
        text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dp-tunnel-url:hover { text-decoration: underline; }
      .dp-tunnel-actions { display: flex; gap: 2px; flex: 0 0 auto; }
      .dp-pane .dp-iconbtn--danger:hover { color: var(--dsw-alias-state-error-primary); }
      .dp-pane .dp-iconbtn:disabled { opacity: .4; cursor: default; }
      .dp-tile--live { color: var(--dsw-alias-state-success-primary); }
      .dp-pane a.dp-iconbtn { text-decoration: none; }
      .dp-spin-wrap { display: inline-flex; }
      .dp-group-note { font-size: 10.5px; }
      .dp-spinning { animation: dp-spin 900ms linear infinite; }
      .dp-toolbar-title { font-size: 12px; font-weight: 600; }
      .dp-dot {
        width: 6px; height: 6px; border-radius: 999px; flex: 0 0 auto;
        background: var(--dsw-alias-label-tertiary);
      }
      .dp-dot--on {
        background: var(--dsw-alias-state-success-primary);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 20%, transparent);
      }

      .dp-drop {
        position: absolute; inset: 8px; z-index: 8;
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-layer-1));
        border: 1px dashed var(--dsw-alias-state-business-primary);
        border-radius: var(--dsw-radius-md, 12px);
        color: var(--dsw-alias-label-primary); font-size: 13px;
        pointer-events: none;
      }

      /* progress */
      .dp-progress {
        position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 9;
        padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: 0 4px 16px rgba(0, 0, 0, .12);
      }
      .dp-progress-head {
        display: flex; align-items: center; gap: 8px;
        font-size: 11.5px; color: var(--dsw-alias-label-secondary);
      }
      .dp-progress-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dp-progress-ok { color: var(--dsw-alias-state-success-primary); }
      .dp-progress-track {
        height: 4px; border-radius: 999px; overflow: hidden;
        background: var(--dsw-alias-bg-module-platform);
      }
      .dp-progress-fill {
        height: 100%; border-radius: 999px;
        background: var(--dsw-alias-state-business-primary);
        transition: width 120ms linear;
      }
      .dp-progress-fill.is-indeterminate { width: 40% !important; animation: dp-indeterminate 1.1s var(--dp-ease) infinite; }
      .dp-progress-detail {
        font-size: 10.5px; color: var(--dsw-alias-label-tertiary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      @keyframes dp-indeterminate {
        0% { margin-left: 0; }
        50% { margin-left: 60%; }
        100% { margin-left: 0; }
      }

      /* banner */
      .dp-banner {
        display: flex; align-items: flex-start; gap: 8px;
        margin: 8px; padding: 8px 12px;
        border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
        border-radius: var(--dsw-radius-sm, 8px);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);
        color: var(--dsw-alias-state-error-primary);
        font-size: 12px; line-height: 18px;
      }

      /* preview */
      .dp-overlay {
        position: absolute; inset: 0; z-index: 20;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, .32);
        animation: dp-fade var(--ds-transition-duration-fast, .1s) var(--dp-ease) both;
      }
      .dp-modal {
        display: flex; flex-direction: column; overflow: hidden;
        width: min(94%, 900px); max-height: 88%;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: 0 16px 40px rgba(0, 0, 0, .18);
        animation: dp-modal-in var(--ds-transition-duration-slow, .3s) var(--dp-ease) both;
      }
      @keyframes dp-modal-in {
        from { opacity: 0; transform: translateY(6px) scale(.995); }
        to { opacity: 1; transform: none; }
      }
      .dp-modal-head {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2);
      }
      .dp-modal-icon {
        width: 26px; height: 26px; display: grid; place-items: center; flex: 0 0 auto;
        border-radius: var(--dsw-radius-xs, 4px);
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-secondary);
      }
      .dp-modal-title { font-size: 13px; font-weight: 600; }
      .dp-modal-body { margin: 10px 12px; border-radius: var(--dsw-radius-sm, 8px); overflow: auto; background: var(--dsw-alias-bg-module-platform); }
      .dp-preview-image { max-width: 100%; display: block; margin: 0 auto; }
      .dp-modal-foot {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l2);
      }
      .dp-modal-path {
        flex: 1; min-width: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
      }
      .dp-chip {
        display: inline-flex; align-items: center; padding: 1px 8px;
        border-radius: 999px; background: var(--dsw-alias-bg-module-platform);
        font-size: 10.5px; line-height: 16px; color: var(--dsw-alias-label-secondary);
      }

      /* code preview: CodeMirror 6 mounts here */
      .dp-cm {
        height: 62vh; min-height: 180px; overflow: hidden;
        font-family: var(--ds-font-family-code, "Cascadia Code", Consolas, ui-monospace, monospace);
      }
      .dp-cm .cm-editor { height: 100%; border-radius: var(--dsw-radius-sm, 8px); overflow: hidden; }
      .dp-cm .cm-gutters {
        border-right: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-sm, 8px) 0 0 var(--dsw-radius-sm, 8px);
      }
      .dp-cm .cm-scroller { scrollbar-width: thin; }
      .dp-modal-body .dp-banner { margin: 10px 12px 0; }
      .dp-plain {
        margin: 0; padding: 10px 12px; overflow: auto; max-height: 62vh;
        font-family: var(--ds-font-family-code, "Cascadia Code", Consolas, ui-monospace, monospace);
        font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
      }

      /* image / video / audio / pdf preview */
      .dp-preview-image { max-width: 100%; max-height: 62vh; display: block; margin: 0 auto; }
      .dp-media { display: block; width: 100%; max-height: 62vh; background: transparent; }
      .dp-audio-wrap { padding: 28px 20px; display: flex; justify-content: center; }
      .dp-audio-wrap .dp-media { max-width: 520px; }
      .dp-pdf { display: block; width: 100%; height: 62vh; border: 0; background: var(--dsw-alias-bg-base); }

      /* auth prompt */
      .dp-auth {
        display: flex; flex-direction: column; gap: 12px;
        width: min(92%, 380px); padding: 18px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: 0 16px 40px rgba(0, 0, 0, .18);
        animation: dp-modal-in var(--ds-transition-duration-slow, .3s) var(--dp-ease) both;
      }
      .dp-auth-head { display: flex; align-items: center; gap: 10px; }
      .dp-auth-icon {
        width: 30px; height: 30px; display: grid; place-items: center;
        border-radius: var(--dsw-radius-sm, 8px);
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-secondary);
      }
      .dp-auth-title { font-size: 13px; font-weight: 600; }
      .dp-auth-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
      .dp-auth-row { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .dp-auth-actions { display: flex; justify-content: flex-end; gap: 8px; }

      /* ------------------------------------------------ file context menu */
      @keyframes dp-fade { from { opacity: 0; } to { opacity: 1; } }
      /* Diff / tail viewers cover the whole window instead of just the right
         sidebar; the pane is far too narrow for a unified diff. */
      .dp-overlay--fixed {
        position: fixed; inset: 0; z-index: 2147481500;
      }
      .dp-overlay--fixed .dp-modal--wide { width: min(94vw, 1080px); }
      .dp-menu {
        position: fixed; z-index: 2147482000; min-width: 178px; max-height: 70vh;
        overflow: auto; padding: 4px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 10px);
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: 0 14px 36px rgba(0, 0, 0, .2), 0 1px 2px rgba(0, 0, 0, .08);
        animation: dp-fade var(--dp-fast, .1s) var(--dp-ease) both;
      }
      .dp-menu-head {
        padding: 5px 9px 4px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
      }
      .dp-menu-item {
        display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 6px 9px; border: 0; border-radius: 6px;
        background: transparent; color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 12.5px; line-height: 18px; text-align: left;
        cursor: pointer; white-space: nowrap;
        transition: background-color var(--dp-fast, .1s) var(--dp-ease, ease);
      }
      .dp-menu-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .dp-menu-item:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
      .dp-menu-item:disabled { opacity: .45; cursor: default; }
      .dp-menu-item--danger { color: var(--dsw-alias-state-error-primary); }
      .dp-menu-item-icon { display: inline-flex; width: 15px; justify-content: center; color: var(--dsw-alias-label-tertiary); }
      .dp-menu-item--danger .dp-menu-item-icon { color: var(--dsw-alias-state-error-primary); }
      .dp-menu-sep { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-l2); }

      /* ----------------------------------------------------- prompt dialog */
      .dp-dialog {
        display: flex; flex-direction: column; gap: 10px;
        width: min(92%, 400px); padding: 16px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: 0 16px 40px rgba(0, 0, 0, .18);
        animation: dp-modal-in var(--ds-transition-duration-slow, .3s) var(--dp-ease) both;
      }
      .dp-dialog-title { font-size: 13px; font-weight: 600; }
      .dp-dialog-hint { font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
      .dp-dialog-path {
        font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 11px;
        color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dp-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .dp-pane .dp-dialog .dp-input { width: 100%; height: 30px; }

      /* -------------------------------------------------------- diff viewer */
      .dp-modal--wide { width: min(96%, 1040px); }
      .dp-diff-form {
        display: flex; flex-direction: column; gap: 8px;
        padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2);
        flex: 0 0 auto;
      }
      .dp-diff-row { display: flex; gap: 8px; align-items: flex-end; }
      .dp-diff-row .dp-field { flex: 1 1 0; min-width: 0; }
      .dp-diff-row .dp-field--mode { flex: 0 0 auto; }
      .dp-diff-form .dp-input { width: 100%; height: 30px; }
      .dp-diff-form .dp-select { max-width: none; width: 100%; }
      .dp-diff-stats {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 8px 12px 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); flex: 0 0 auto;
      }
      .dp-diff-stat-add { color: var(--dsw-alias-state-success-primary); font-weight: 600; }
      .dp-diff-stat-rem { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
      .dp-diff-pre {
        margin: 0; padding: 6px 0 10px; overflow: auto; max-height: 56vh;
        font-family: var(--ds-font-family-code, "Cascadia Code", Consolas, ui-monospace, monospace);
        font-size: 11.5px; line-height: 1.6;
      }
      .dp-diff-line { display: block; padding: 0 12px; white-space: pre; min-height: 1.6em; }
      .dp-diff-add { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent); color: var(--dsw-alias-state-success-primary); }
      .dp-diff-del { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
      .dp-diff-hunk { color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-module-platform); }
      .dp-diff-meta { color: var(--dsw-alias-label-tertiary); font-weight: 600; }
      .dp-diff-context { color: var(--dsw-alias-label-primary); }
      .dp-diff-empty { padding: 26px 12px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .dp-diff-hint { padding: 0 12px 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }

      /* ----------------------------------------------------------- log tail */
      .dp-tail-pre {
        margin: 0; padding: 10px 12px; overflow: auto; max-height: 58vh;
        font-family: var(--ds-font-family-code, "Cascadia Code", Consolas, ui-monospace, monospace);
        font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
        -webkit-user-select: text; user-select: text;
      }
      .dp-tail-stats { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary); flex: 0 0 auto; }
      .dp-tail-live { color: var(--dsw-alias-state-success-primary); display: inline-flex; align-items: center; gap: 4px; }
      .dp-check { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; white-space: nowrap; }
      .dp-check input { margin: 0; }

      /* ------------------------------------------ discovered ports / presets */
      .dp-discover {
        display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
        padding: 7px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2);
        flex: 0 0 auto;
      }
      .dp-discover-label { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
      .dp-port-chip {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 2px 2px 2px 9px; border-radius: 999px;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-module-platform);
        font-size: 11px; color: var(--dsw-alias-label-primary); cursor: default;
      }
      .dp-port-chip .dp-port-num { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-weight: 600; }
      .dp-port-chip .dp-port-proc {
        color: var(--dsw-alias-label-tertiary); max-width: 88px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dp-port-chip .dp-port-btn {
        border: 0; border-radius: 999px; padding: 1px 7px; cursor: pointer;
        background: transparent; color: var(--dsw-alias-state-business-primary);
        font: inherit; font-size: 10.5px;
        transition: background-color var(--dp-fast) var(--dp-ease);
      }
      .dp-port-chip .dp-port-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dp-port-chip .dp-port-dismiss {
        border: 0; border-radius: 999px; width: 16px; height: 16px; padding: 0;
        display: grid; place-items: center; cursor: pointer;
        background: transparent; color: var(--dsw-alias-label-tertiary);
      }
      .dp-port-chip .dp-port-dismiss:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .dp-presets {
        padding: 6px 8px 2px; border-bottom: 1px solid var(--dsw-alias-border-l2);
        flex: 0 0 auto; max-height: 138px; overflow: auto;
      }
      .dp-preset-row { display: flex; align-items: center; gap: 8px; padding: 4px 2px; font-size: 12px; }
      .dp-preset-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .dp-preset-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
      .dp-preset-route {
        font-size: 10.5px; color: var(--dsw-alias-label-tertiary);
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dp-preset-open { font-size: 10.5px; color: var(--dsw-alias-state-success-primary); flex: 0 0 auto; }

      /* --------------------------------------------------- settings toggle */
      .dp-setting-row { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: var(--dsw-radius-sm, 8px); }
      .dp-setting-row + .dp-setting-row { border-top: 1px solid var(--dsw-alias-border-l2); }
      .dp-setting-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .dp-setting-title { font-size: 12.5px; font-weight: 500; }
      .dp-setting-hint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }

      /* ------------------------------------------------------ 0.21 wait dock */
      .dp-wait-dock {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147482500;
        display: flex; flex-direction: column; align-items: flex-end;
        pointer-events: none;
      }
      .dp-wait-dock > * { pointer-events: auto; }
      .dp-wait-pill {
        display: inline-flex; align-items: center; gap: 7px;
        max-width: min(420px, calc(100vw - 32px));
        padding: 8px 14px; border-radius: 999px;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 12.5px; cursor: pointer;
        box-shadow: 0 8px 24px rgba(0, 0, 0, .16), 0 1px 2px rgba(0, 0, 0, .06);
        transition:
          transform var(--dp-fast, .1s) var(--dp-ease, ease),
          box-shadow var(--dp-base, 220ms) var(--dp-ease, ease),
          border-color var(--dp-fast, .1s) var(--dp-ease, ease);
        animation: dp-toast-in 200ms var(--dp-ease, ease) both;
      }
      .dp-wait-pill:hover {
        transform: translateY(-1px);
        border-color: var(--dsw-alias-border-l3);
        box-shadow: 0 10px 28px rgba(0, 0, 0, .2);
      }
      .dp-wait-pill:active { transform: translateY(0) scale(.99); }
      .dp-wait-pill:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent);
      }
      .dp-wait-pill-icon { display: inline-flex; font-size: 14px; line-height: 1; }
      .dp-wait-pill-count { font-weight: 600; white-space: nowrap; }
      .dp-wait-pill-label {
        color: var(--dsw-alias-label-secondary); font-size: 11.5px;
        max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dp-wait-card {
        width: min(420px, calc(100vw - 32px));
        max-height: min(62vh, 540px);
        display: flex; flex-direction: column; overflow: hidden;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        box-shadow: 0 16px 40px rgba(0, 0, 0, .2), 0 1px 2px rgba(0, 0, 0, .06);
        animation: dp-modal-in var(--ds-transition-duration-slow, .3s) var(--dp-ease, ease) both;
      }
      .dp-wait-head {
        display: flex; align-items: center; gap: 6px;
        padding: 9px 10px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2);
        flex: 0 0 auto;
      }
      .dp-wait-head-icon { display: inline-flex; color: var(--dsw-alias-label-secondary); }
      .dp-wait-title { font-size: 12.5px; font-weight: 600; white-space: nowrap; }
      .dp-wait-chip {
        padding: 0 7px; border-radius: 999px; line-height: 16px;
        font-size: 10.5px; background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-secondary); white-space: nowrap;
      }
      .dp-wait-btn {
        display: inline-flex; align-items: center; gap: 4px;
        height: 24px; padding: 0 8px; border: 0; border-radius: 6px;
        background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 11.5px; cursor: pointer; white-space: nowrap;
      }
      .dp-wait-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .dp-wait-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
      .dp-wait-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 6px 6px; }
      .dp-wait-row {
        display: flex; align-items: flex-start; gap: 8px; width: 100%;
        padding: 7px; border: 0; border-radius: 8px;
        background: transparent; color: inherit; font: inherit;
        text-align: left; cursor: pointer;
        transition: background-color var(--dp-fast, .1s) var(--dp-ease, ease);
      }
      .dp-wait-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dp-wait-row:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
      .dp-wait-state { display: inline-flex; margin-top: 2px; color: var(--dsw-alias-state-business-primary); flex: 0 0 auto; }
      .dp-wait-row.is-done .dp-wait-state { color: var(--dsw-alias-state-success-primary); }
      .dp-wait-row.is-timeout .dp-wait-state { color: var(--dsw-alias-state-warn-primary); }
      .dp-wait-row.is-error .dp-wait-state { color: var(--dsw-alias-state-error-primary); }
      .dp-wait-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .dp-wait-top { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
      .dp-wait-label {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; font-size: 12.5px;
      }
      .dp-wait-host {
        flex: 0 0 auto; max-width: 120px; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; font-size: 10.5px; color: var(--dsw-alias-label-tertiary);
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
      }
      .dp-wait-elapsed {
        flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-secondary);
        font-variant-numeric: tabular-nums;
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
      }
      .dp-wait-bar {
        height: 4px; border-radius: 999px; overflow: hidden;
        background: var(--dsw-alias-bg-module-platform);
      }
      .dp-wait-bar-fill {
        height: 100%; border-radius: 999px;
        background: var(--dsw-alias-state-business-primary);
        transition: width 300ms var(--dp-ease, ease);
      }
      .dp-wait-row.is-done .dp-wait-bar-fill { background: var(--dsw-alias-state-success-primary); }
      .dp-wait-row.is-timeout .dp-wait-bar-fill { background: var(--dsw-alias-state-warn-primary); }
      .dp-wait-row.is-error .dp-wait-bar-fill { background: var(--dsw-alias-state-error-primary); }
      .dp-wait-meta {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        font-size: 10.5px; color: var(--dsw-alias-label-secondary);
      }
      .dp-wait-progress {
        font-variant-numeric: tabular-nums;
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
      }
      .dp-wait-progress.is-muted { color: var(--dsw-alias-label-tertiary); }
      .dp-wait-eta { color: var(--dsw-alias-label-tertiary); }
      .dp-wait-state-label { margin-left: auto; color: var(--dsw-alias-label-tertiary); }
      .dp-wait-line {
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
        font-size: 10.5px; line-height: 14px; color: var(--dsw-alias-label-tertiary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dp-wait-foot {
        flex: 0 0 auto; padding: 6px 10px 7px;
        border-top: 1px solid var(--dsw-alias-border-l2);
        font-size: 10.5px; color: var(--dsw-alias-label-tertiary);
      }
      .dp-wait-error {
        flex: 0 0 auto; margin: 6px 8px 0; padding: 6px 8px;
        border-radius: 6px; font-size: 10.5px; overflow-wrap: anywhere;
        color: var(--dsw-alias-state-error-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
      }
      .dp-wait-detail {
        flex: 1 1 auto; min-height: 0; overflow: auto;
        padding: 6px 10px 8px; display: flex; flex-direction: column; gap: 4px;
      }
      .dp-wait-kv { display: flex; gap: 8px; font-size: 11.5px; line-height: 16px; }
      .dp-wait-k { flex: 0 0 64px; color: var(--dsw-alias-label-tertiary); }
      .dp-wait-v {
        flex: 1; min-width: 0; overflow-wrap: anywhere;
        font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 11px;
      }
      .dp-wait-sub { margin-top: 4px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
      .dp-wait-samples {
        display: flex; flex-direction: column; gap: 1px;
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
        font-size: 10.5px; color: var(--dsw-alias-label-secondary);
      }
      .dp-wait-sample { display: flex; justify-content: space-between; gap: 8px; }
      .dp-wait-monoline {
        margin: 0; padding: 6px 8px; border-radius: 6px;
        background: var(--dsw-alias-bg-module-platform);
        font-family: var(--ds-font-family-code, ui-monospace, monospace);
        font-size: 10.5px; line-height: 14px;
        white-space: pre-wrap; word-break: break-word;
        max-height: 80px; overflow: auto;
      }
      @media (prefers-reduced-motion: reduce) {
        .dp-wait-pill, .dp-wait-card, .dp-wait-row, .dp-wait-bar-fill { transition: none; animation: none; }
      }
`;
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
    }

    function Button({ label, onClick, primary, disabled, small, className, title }) {
      return h('button', {
        type: 'button',
        onClick,
        disabled,
        title,
        className: [
          'dp-btn',
          small ? 'dp-btn--sm' : '',
          primary ? 'dp-btn--primary' : '',
          className ?? '',
        ].filter(Boolean).join(' '),
      }, label);
    }

    function Banner({ children }) {
      return h('div', {
        role: 'alert',
        style: {
          margin: '10px 0',
          padding: '8px 12px',
          borderRadius: 8,
          fontSize: 12,
          color: C.error,
          background: C.soft,
          border: `1px solid ${C.error}`,
        },
      }, children);
    }

    /** 1536 → "1.5 KB" — compact, for a file list column. */
    function humanSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
      if (bytes < 1024) return `${bytes} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = bytes / 1024;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
    }

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    /**
     * Remote folder browser: machine badge, breadcrumb pills, optional filter,
     * icon rows with metadata, and an inline file preview. Used both for picking
     * a new workspace folder and for browsing an existing one.
     */
    function BrowserCard({ host, crumbs, entries, dirsOnly, busy, onOpenDir, onOpenFile, onBack, preview, hint }) {
      const [filter, setFilter] = useState('');
      const current = crumbs.at(-1)?.path ?? '/';
      // Navigating to another folder starts from an unfiltered view.
      useEffect(() => {
        setFilter('');
      }, [current]);
      const dirs = entries.filter((entry) => entry.kind === 'dir').sort((a, b) => a.name.localeCompare(b.name));
      const files = dirsOnly
        ? []
        : entries.filter((entry) => entry.kind !== 'dir').sort((a, b) => a.name.localeCompare(b.name));
      const needle = filter.trim().toLowerCase();
      const visible = [...dirs, ...files].filter((entry) => !needle || entry.name.toLowerCase().includes(needle));
      const atRoot = crumbs.length <= 1;

      const row = (entry) => h('button', {
        key: entry.path,
        type: 'button',
        disabled: busy,
        title: entry.path,
        className: 'dp-row',
        onClick: () => (entry.kind === 'dir' ? onOpenDir(entry.path) : onOpenFile?.(entry.path)),
      }, [
        h('span', { key: 'icon', className: 'dp-icon' }, entry.kind === 'dir' ? '📁' : '📄'),
        h('span', {
          key: 'name',
          style: {
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', fontSize: 13,
          },
        }, entry.name),
        typeof entry.size === 'number' && entry.kind !== 'dir'
          ? h('span', { key: 'size', style: { color: C.muted, fontSize: 11, flex: '0 0 auto' } }, humanSize(entry.size))
          : null,
        entry.kind === 'dir'
          ? h('span', { key: 'go', style: { color: C.muted, fontSize: 14, flex: '0 0 auto' } }, '›')
          : null,
      ]);

      return h('div', {
        className: 'dp-card',
      }, [
        h('div', {
          key: 'head',
          style: {
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px 10px', borderBottom: `1px solid ${C.border}`,
          },
        }, [
          atRoot
            ? null
            : h('button', {
                key: 'back',
                type: 'button',
                title: '返回上层',
                disabled: busy,
                onClick: onBack,
                className: 'dp-iconbtn',
              }, '←'),
          h('span', {
            key: 'host',
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 5, flex: '0 0 auto',
              padding: '3px 8px', borderRadius: 999, background: C.soft, fontSize: 11, color: C.muted,
            },
          }, [
            h('span', { key: 'dot', style: { width: 6, height: 6, borderRadius: '50%', background: C.ok } }),
            host,
          ]),
          h('span', {
            key: 'path',
            style: {
              flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11, color: C.muted,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right',
            },
          }, crumbs.at(-1)?.path ?? '/'),
          h('span', { key: 'count', style: { fontSize: 11, color: C.muted, flex: '0 0 auto' } }, `${visible.length} 项`),
        ]),
        h('div', {
          key: 'crumbs',
          style: {
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1,
            padding: '6px 10px', borderBottom: `1px solid ${C.border}`,
          },
        }, crumbs.map((crumb, index) => h('span', {
          key: `${crumb.path}#${index}`,
          style: { display: 'inline-flex', alignItems: 'center', gap: 1 },
        }, [
          index > 0 ? h('span', { key: 'sep', style: { color: C.muted, fontSize: 11, padding: '0 1px' } }, '›') : null,
          h('button', {
            key: 'crumb',
            type: 'button',
            disabled: busy,
            onClick: () => onOpenDir(crumb.path),
            className: index === crumbs.length - 1 ? 'dp-crumb dp-crumb--current' : 'dp-crumb',
          }, index === 0 ? '/' : crumb.name),
        ]))),
        entries.length > 8
          ? h('div', {
              key: 'filter',
              style: { padding: '7px 10px', borderBottom: `1px solid ${C.border}` },
            }, h('input', {
              value: filter,
              placeholder: '筛选当前文件夹…',
              onChange: (event) => setFilter(event.target.value),
              className: 'dp-input',
            }))
          : null,
        h('div', {
          key: 'list',
          style: { maxHeight: 330, overflowY: 'auto', padding: 6 },
        }, visible.length === 0
          ? h('div', {
              style: { padding: '26px 12px', textAlign: 'center', color: C.muted, fontSize: 12 },
            }, [
              h('div', { key: 'i', style: { fontSize: 20, marginBottom: 6, opacity: 0.7 } }, '📂'),
              h('div', { key: 't' }, needle ? '没有匹配的条目' : dirsOnly ? '这个文件夹里没有子文件夹' : '空文件夹'),
            ])
          : visible.map(row)),
        preview
          ? h('div', { key: 'preview', style: { borderTop: `1px solid ${C.border}` } }, [
              h('div', {
                key: 'head',
                style: {
                  padding: '7px 10px', fontSize: 11, color: C.muted,
                  display: 'flex', gap: 8, alignItems: 'center',
                },
              }, [
                h('span', { key: 'label', style: { flex: '0 0 auto' } }, '预览'),
                h('span', {
                  key: 'path',
                  style: {
                    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap', fontFamily: MONO,
                  },
                }, preview.path),
                preview.truncated ? h('span', { key: 'more', style: { flex: '0 0 auto' } }, '已截断') : null,
              ]),
              h('pre', {
                key: 'content',
                style: {
                  margin: 0, padding: '0 12px 12px', maxHeight: 280, overflow: 'auto',
                  fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word', fontFamily: MONO,
                },
              }, preview.content),
            ])
          : null,
        hint
          ? h('div', {
              key: 'hint',
              style: {
                padding: '7px 10px', borderTop: `1px solid ${C.border}`,
                fontSize: 11, color: C.muted,
              },
            }, hint)
          : null,
      ]);
    }

    // ------------------------------------------------------------- spinner
    function Spinner({ label, size = 16 }) {
      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 8, color: C.muted, fontSize: 12 },
      }, [
        h('span', {
          key: 'ring',
          className: 'dp-spin',
          style: { width: size, height: size, display: 'inline-block', flex: '0 0 auto' },
        }),
        label ? h('span', { key: 'label' }, label) : null,
      ]);
    }

    // ------------------------------------------------- remote file browser
    const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
    // Everything text-ish opens in the CodeMirror preview (line numbers always,
    // syntax colours when the language is known). This includes data formats
    // such as .json/.yaml/.toml/.xml — previously they fell into a plain <pre>.
    const TEXT_EXTENSIONS = new Set([
      'txt', 'md', 'markdown', 'json', 'jsonc', 'json5', 'log', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini',
      'conf', 'cfg', 'xml', 'tex', 'properties', 'gitignore', 'gitattributes', 'dockerignore', 'env', 'lock',
      'make', 'mk', 'patch', 'diff', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'pyi', 'rb',
      'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh',
      'fish', 'ps1', 'psm1', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'sass', 'gradle', 'vue', 'svelte',
      'lua', 'pl', 'swift', 'dart', 'r', 'jl', 'hs', 'ex', 'exs', 'erl', 'clj', 'scala', 'groovy', 'cmake',
    ]);
    const CODE_EXTENSIONS = TEXT_EXTENSIONS;
    // Stroke icons (Lucide geometry) so the pane uses real UI icons instead of emoji.
    const ICONS = {
      folder: ['M4 7a2 2 0 0 1 2-2h3.6l2 2H18a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z'],
      file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
      code: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M10 12l-2 2 2 2', 'M14 12l2 2-2 2'],
      text: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
      image: ['M4 5h16v14H4z', 'M9 11a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3z', 'M4 16l4.5-4.5 3.5 3.5 3-3L20 15'],
      download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
      trash: ['M4 7h16', 'M10 11v5', 'M14 11v5', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
      plus: ['M12 5v14', 'M5 12h14'],
      'folder-plus': ['M4 7a2 2 0 0 1 2-2h3.6l2 2H18a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M12 12v5', 'M9.5 14.5h5'],
      refresh: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4v5h-5'],
      upload: ['M12 20V9', 'M7 14l5-5 5 5', 'M5 4h14'],
      chevron: ['M9 6l6 6-6 6'],
      x: ['M6 6l12 12', 'M18 6L6 18'],
      lock: ['M7 10V8a5 5 0 0 1 10 0v2', 'M5 10h14v10H5z'],
      check: ['M4 12l5 5L20 6'],
      alert: ['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z', 'M12 8v5', 'M12 16.5v.5'],
      info: ['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z', 'M12 11v5', 'M12 7.5v.5'],
      server: ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M7.5 7h.01', 'M7.5 17h.01'],
      search: ['M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z', 'M20 20l-3.6-3.6'],
      play: ['M8 5l11 7-11 7z'],
      external: ['M14 4h6v6', 'M20 4l-9 9', 'M10 5H5v14h14v-5'],
      copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
      power: ['M12 3v9', 'M6.4 6.4a8 8 0 1 0 11.2 0'],
      music: ['M9 17V5l10-2v12', 'M9 17a3 3 0 1 1-6 0a3 3 0 0 1 6 0z', 'M19 15a3 3 0 1 1-6 0a3 3 0 0 1 6 0z'],
      more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
      clock: ['M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
    };

    function Icon({ name, size = 16, style }) {
      const paths = ICONS[name] ?? ICONS.file;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flex: '0 0 auto', display: 'block', ...style },
      }, paths.map((d, index) => h('path', { key: index, d })));
    }

    function extensionOf(name) {
      if (typeof name !== 'string') return '';
      const index = name.lastIndexOf('.');
      return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
    }

    function isImageName(name) {
      return IMAGE_EXTENSIONS.has(extensionOf(name));
    }

    function isCodeName(name) {
      return CODE_EXTENSIONS.has(extensionOf(name));
    }

    function isTextName(name) {
      return TEXT_EXTENSIONS.has(extensionOf(name)) || isCodeName(name) || extensionOf(name) === '';
    }

    const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi']);
    const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus']);

    /** Which inline preview a file gets: 'image' | 'video' | 'audio' | 'pdf' | 'code' | null. */
    function previewKindOf(name) {
      const extension = extensionOf(name);
      if (IMAGE_EXTENSIONS.has(extension)) return 'image';
      if (VIDEO_EXTENSIONS.has(extension)) return 'video';
      if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
      if (extension === 'pdf') return 'pdf';
      if (isTextName(name)) return 'code';
      return null;
    }

    function entryIconName(entry) {
      if (entry.kind === 'dir') return 'folder';
      const kind = previewKindOf(entry.name);
      if (kind === 'image') return 'image';
      if (kind === 'video') return 'play';
      if (kind === 'audio') return 'music';
      if (kind === 'code') return 'code';
      if (kind === 'pdf') return 'text';
      return 'file';
    }

    function rawUrlFor(host, path, download) {
      const query = `host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`;
      return `${API}/raw?${query}${download ? '&download=1' : ''}`;
    }

    function formatMoment(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      const date = new Date(ms);
      const ago = Date.now() - ms;
      if (ago >= 0 && ago < 60_000) return '刚刚';
      if (ago >= 0 && ago < 3_600_000) return `${Math.floor(ago / 60_000)} 分钟前`;
      if (ago >= 0 && ago < 86_400_000) return `${Math.floor(ago / 3_600_000)} 小时前`;
      return `${date.toLocaleDateString()} ${date.toLocaleTimeString().slice(0, 5)}`;
    }

    /** Read-only CodeMirror 6 view: syntax highlighting, line numbers, fold. */
    function CodeView({ content, name }) {
      const host = useRef(null);
      const [failed, setFailed] = useState(false);
      useEffect(() => {
        let disposed = false;
        let handle = null;
        setFailed(false);
        if (!host.current) return undefined;
        mountCodeView(host.current, { content, name })
          .then((created) => {
            if (disposed) created?.destroy();
            else handle = created;
          })
          .catch(() => {
            // Never show a blank panel: fall back to plain monospace text.
            if (!disposed) setFailed(true);
          });
        return () => {
          disposed = true;
          handle?.destroy();
        };
      }, [content, name]);
      return failed
        ? h('pre', { className: 'dp-plain' }, content)
        : h('div', { ref: host, className: 'dp-cm' });
    }

    // ------------------------------------------------------- 0.18 UI kit
    // Shared chrome for the new modal flows: one overlay, one header and an
    // optional footer. Escape is routed by the owning panel so only the
    // top-most layer reacts (menu > dialog > diff/tail > preview > auth).
    function ModalShell({ icon, title, chip, onClose, children, footer, wide, fixed }) {
      return h('div', {
        className: fixed ? 'dp-overlay dp-overlay--fixed' : 'dp-overlay',
        onMouseDown: () => onClose?.(),
      }, h('div', {
        className: wide ? 'dp-modal dp-modal--wide' : 'dp-modal',
        onMouseDown: (event) => event.stopPropagation(),
        role: 'dialog',
        'aria-modal': 'true',
      }, [
        h('div', { key: 'head', className: 'dp-modal-head' }, [
          h('span', { key: 'icon', className: 'dp-modal-icon' }, h(Icon, { name: icon ?? 'file', size: 16 })),
          h('span', {
            key: 'title',
            className: 'dp-modal-title',
            style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, title),
          chip ? h('span', { key: 'chip', className: 'dp-chip' }, chip) : null,
          h('button', {
            key: 'close',
            type: 'button',
            className: 'dp-iconbtn',
            title: '关闭 (Esc)',
            onClick: onClose,
          }, h(Icon, { name: 'x', size: 16 })),
        ]),
        children,
        footer ? h('div', { key: 'foot', className: 'dp-modal-foot' }, footer) : null,
      ]));
    }

    /**
     * Fixed-position row menu. `items` entries are
     * {key,label,icon,danger,disabled,onClick}; a null entry renders a divider.
     */
    function ContextMenu({ x, y, title, items, onClose }) {
      const closeRef = useRef(onClose);
      closeRef.current = onClose;
      const menuRef = useRef(null);
      useEffect(() => {
        const close = () => closeRef.current?.();
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          close();
        };
        // A mousedown inside the menu must reach the item's click handler; only
        // an outside press dismisses it.
        const onMouseDown = (event) => {
          const node = menuRef.current;
          if (node && event.target instanceof Node && node.contains(event.target)) return;
          close();
        };
        // Defer: the contextmenu/mousedown that opened the menu must not close
        // it on the same gesture.
        const timer = setTimeout(() => {
          document.addEventListener('mousedown', onMouseDown, true);
          window.addEventListener('resize', close);
          window.addEventListener('scroll', close, true);
        }, 0);
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          clearTimeout(timer);
          document.removeEventListener('mousedown', onMouseDown, true);
          window.removeEventListener('resize', close);
          window.removeEventListener('scroll', close, true);
          window.removeEventListener('keydown', onKeyDown, true);
        };
      }, []);

      const width = 200;
      const left = Math.max(8, Math.min(Number(x) || 8, (window.innerWidth || 1280) - width - 8));
      const top = Math.max(8, Math.min(Number(y) || 8, (window.innerHeight || 800) - 300));
      return h('div', {
        ref: menuRef,
        className: 'dp-menu',
        style: { left, top, width },
        role: 'menu',
        onContextMenu: (event) => event.preventDefault(),
      }, [
        title ? h('div', { key: 'head', className: 'dp-menu-head', title }, title) : null,
        ...items.filter(Boolean).map((item) => (item.separator
          ? h('div', { key: item.key, className: 'dp-menu-sep' })
          : h('button', {
              key: item.key,
              type: 'button',
              role: 'menuitem',
              disabled: item.disabled,
              className: item.danger ? 'dp-menu-item dp-menu-item--danger' : 'dp-menu-item',
              onClick: () => {
                closeRef.current?.();
                item.onClick?.();
              },
            }, [
              h('span', { key: 'icon', className: 'dp-menu-item-icon' }, item.icon ? h(Icon, { name: item.icon, size: 14 }) : null),
              h('span', { key: 'label' }, item.label),
            ]))),
      ]);
    }

    /** Small single-input dialog used by mkdir / rename / chmod. */
    function PromptDialog({ title, path, hint, value, placeholder, error, busy, inputMode, onChange, onSubmit, onCancel }) {
      return h('div', {
        className: 'dp-overlay',
        onMouseDown: onCancel,
      }, h('div', {
        className: 'dp-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        onMouseDown: (event) => event.stopPropagation(),
      }, [
        h('div', { key: 'title', className: 'dp-dialog-title' }, title),
        path ? h('div', { key: 'path', className: 'dp-dialog-path' }, path) : null,
        hint ? h('div', { key: 'hint', className: 'dp-dialog-hint' }, hint) : null,
        h('input', {
          key: 'input',
          className: 'dp-input',
          autoFocus: true,
          value,
          placeholder,
          inputMode,
          spellCheck: false,
          onChange: (event) => onChange(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') onSubmit();
            if (event.key === 'Escape') onCancel();
          },
        }),
        error ? h('div', { key: 'error', className: 'dp-dialog-hint', style: { color: C.error } }, error) : null,
        h('div', { key: 'actions', className: 'dp-dialog-actions' }, [
          h('button', { key: 'cancel', type: 'button', className: 'dp-tool', onClick: onCancel }, '取消'),
          h('button', {
            key: 'ok',
            type: 'button',
            className: 'dp-tool dp-tool--primary',
            disabled: busy,
            onClick: onSubmit,
          }, busy ? '处理中…' : '确定'),
        ]),
      ]));
    }

    /**
     * Remote-vs-remote / remote-vs-local diff viewer. A is prefilled with the
     * row's path; B is either another remote path on the same host or a path on
     * the machine running the host process. GET /diff returns the frozen
     * { ok, diff, stats:{added,removed}, truncated } shape.
     */
    function DiffModal({ host, path: initialPath, onClose }) {
      const [a, setA] = useState(initialPath ?? '');
      const [b, setB] = useState('');
      const [mode, setMode] = useState('remote');
      const [localPath, setLocalPath] = useState('');
      const [context, setContext] = useState('3');
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const [result, setResult] = useState(null);

      const run = useCallback(async () => {
        const left = a.trim();
        const right = (mode === 'remote' ? b : localPath).trim();
        if (!left) {
          setError('A 不能为空：填这台机器上的远程路径');
          return;
        }
        if (!right) {
          notifyError({ title: t('toast.diffNeedTarget'), hint: t('toast.diffNeedTarget.hint') });
          return;
        }
        setLoading(true);
        setError('');
        try {
          const query = new URLSearchParams({ host, a: left });
          if (mode === 'remote') query.set('b', right);
          else query.set('localPath', right);
          const wanted = Number(context);
          if (Number.isInteger(wanted) && wanted >= 0 && wanted <= 20) query.set('context', String(wanted));
          const data = await request(`/diff?${query.toString()}`);
          setResult({
            diff: String(data.diff ?? ''),
            stats: data.stats ?? {},
            truncated: Boolean(data.truncated),
          });
        } catch (err) {
          setResult(null);
          setError(isMissingEndpointError(err.message)
            ? `${t('toast.unsupportedFeature')}：${t('toast.unsupportedFeature.hint')}`
            : err.message);
        } finally {
          setLoading(false);
        }
      }, [a, b, mode, localPath, context, host]);

      const lines = result ? splitDiffLines(result.diff) : [];
      const body = result
        ? (lines.length === 0
            ? h('div', { key: 'empty', className: 'dp-diff-empty' }, '没有差异')
            : h('pre', { key: 'diff', className: 'dp-diff-pre' }, lines.map((line, index) => h('span', {
                key: index,
                className: `dp-diff-line dp-diff-${line.kind}`,
              }, line.text || ' '))))
        : null;

      return h(ModalShell, {
        icon: 'text',
        title: '文件对比',
        chip: host,
        wide: true,
        fixed: true,
        onClose,
        footer: [
          h('span', { key: 'path', className: 'dp-modal-path' }, mode === 'remote' ? `${a}  ↔  ${b}` : `${a}  ↔  ${localPath}`),
          h('button', { key: 'close', type: 'button', className: 'dp-tool', onClick: onClose }, '关闭'),
        ],
      }, [
        h('div', { key: 'form', className: 'dp-diff-form' }, [
          h('div', { key: 'rowA', className: 'dp-diff-row' }, [
            h('div', { key: 'a', className: 'dp-field' }, [
              h('label', { key: 'label', className: 'dp-field-label' }, `远程文件 A（${host}）`),
              h('input', {
                key: 'input',
                className: 'dp-input dp-mono',
                value: a,
                spellCheck: false,
                placeholder: '/path/on/remote',
                onChange: (event) => setA(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') run(); },
              }),
            ]),
          ]),
          h('div', { key: 'rowB', className: 'dp-diff-row' }, [
            h('div', { key: 'mode', className: 'dp-field dp-field--mode' }, [
              h('label', { key: 'label', className: 'dp-field-label' }, 'B 是'),
              h('select', {
                key: 'select',
                className: 'dp-select',
                value: mode,
                onChange: (event) => setMode(event.target.value),
              }, [
                h('option', { key: 'remote', value: 'remote' }, '远程文件'),
                h('option', { key: 'local', value: 'local' }, '本地文件'),
              ]),
            ]),
            h('div', { key: 'b', className: 'dp-field' }, [
              h('label', { key: 'label', className: 'dp-field-label' },
                mode === 'remote' ? `远程文件 B（${host}）` : '本地文件路径（host 所在机器）'),
              h('input', {
                key: 'input',
                className: 'dp-input dp-mono',
                value: mode === 'remote' ? b : localPath,
                spellCheck: false,
                placeholder: mode === 'remote' ? '/path/on/remote' : './relative/to/repo or C:\\path\\file',
                onChange: (event) => (mode === 'remote' ? setB(event.target.value) : setLocalPath(event.target.value)),
                onKeyDown: (event) => { if (event.key === 'Enter') run(); },
              }),
            ]),
            h('div', { key: 'ctx', className: 'dp-field dp-field--mode', style: { flex: '0 0 64px' } }, [
              h('label', { key: 'label', className: 'dp-field-label' }, '上下文'),
              h('input', {
                key: 'input',
                className: 'dp-input dp-mono',
                value: context,
                inputMode: 'numeric',
                title: '上下文行数（0-20）',
                onChange: (event) => setContext(event.target.value.replace(/[^\d]/gu, '')),
              }),
            ]),
            h('button', {
              key: 'run',
              type: 'button',
              className: 'dp-tool dp-tool--primary',
              disabled: loading,
              onClick: run,
            }, loading ? '对比中…' : '比较'),
          ]),
        ]),
        error || loading || result
          ? h('div', { key: 'stats', className: 'dp-diff-stats' }, [
              error ? h('span', { key: 'err', style: { color: C.error } }, error) : null,
              loading ? h(Spinner, { key: 'spin', label: '正在对比…' }) : null,
              result
                ? [
                    h('span', { key: 'label', style: { color: C.muted } }, '统计'),
                    h('span', { key: 'add', className: 'dp-diff-stat-add' }, `+${Number(result.stats.added) || 0}`),
                    h('span', { key: 'rem', className: 'dp-diff-stat-rem' }, `−${Number(result.stats.removed) || 0}`),
                  ]
                : null,
              result?.truncated
                ? h('span', { key: 'trunc', style: { color: C.muted } }, '差异较长，已截断')
                : null,
            ])
          : h('div', { key: 'hint', className: 'dp-diff-hint' },
              'A 默认是刚才选中的文件；B 填同一台机器上的另一个路径，或者切换到「本地文件」填本机路径。'),
        body ? h('div', { key: 'body', className: 'dp-modal-body' }, body) : null,
      ]);
    }

    /**
     * Live log tail. While open (and not paused) it asks the host for the last
     * 200 lines with follow=1 and a 3 s budget, then repeats every ~2 s and
     * scrolls to the bottom. Pause stops the polling loop; close unmounts it.
     */
    function TailModal({ host, path, name, onClose }) {
      const [state, setState] = useState({
        text: '',
        lines: 0,
        bytes: 0,
        truncated: false,
        followedMs: 0,
        passes: 0,
        paused: false,
        loading: true,
        error: '',
      });
      const preRef = useRef(null);
      const paused = state.paused;

      useEffect(() => {
        if (paused) return undefined;
        let cancelled = false;
        let timer = null;
        const loop = async () => {
          if (cancelled) return;
          try {
            const query = new URLSearchParams({
              host,
              path,
              lines: '200',
              follow: '1',
              timeoutMs: '3000',
            });
            const data = await request(`/tail?${query.toString()}`);
            if (cancelled) return;
            setState((current) => ({
              ...current,
              loading: false,
              error: '',
              text: String(data.text ?? ''),
              lines: Number(data.lines) || 0,
              bytes: Number(data.bytes) || 0,
              truncated: Boolean(data.truncated),
              followedMs: Number(data.followedMs) || 0,
              passes: current.passes + 1,
            }));
          } catch (err) {
            if (cancelled) return;
            setState((current) => ({
              ...current,
              loading: false,
              paused: true,
              error: isMissingEndpointError(err.message)
                ? `${t('toast.unsupportedFeature')}：${t('toast.unsupportedFeature.hint')}`
                : err.message,
            }));
            return;
          }
          if (!cancelled) timer = setTimeout(loop, 2000);
        };
        loop();
        return () => {
          cancelled = true;
          if (timer) clearTimeout(timer);
          timer = null;
        };
      }, [host, path, paused]);

      // Follow the log like `tail -f` unless the user paused to read history.
      useEffect(() => {
        const node = preRef.current;
        if (!node || paused) return;
        node.scrollTop = node.scrollHeight;
      }, [state.text, paused]);

      const togglePause = () => setState((current) => ({
        ...current,
        paused: !current.paused,
        loading: current.paused ? true : current.loading,
        error: '',
      }));

      const copyAll = async () => {
        try {
          await navigator.clipboard.writeText(state.text ?? '');
          notifySuccess(t('toast.copied'));
        } catch (err) {
          notifyError({ title: t('toast.copyFailed'), hint: t('toast.copyFailed.hint'), detail: err.message });
        }
      };

      return h(ModalShell, {
        icon: 'code',
        title: `日志 · ${name || remoteBaseName(path)}`,
        chip: host,
        wide: true,
        fixed: true,
        onClose,
        footer: [
          h('span', { key: 'stats', className: 'dp-tail-stats' },
            `${state.lines} 行 · ${humanSize(state.bytes)}`),
          h('span', { key: 'path', className: 'dp-modal-path' }, path),
          h('button', {
            key: 'copy',
            type: 'button',
            className: 'dp-tool',
            disabled: !state.text,
            onClick: copyAll,
          }, [h(Icon, { key: 'i', name: 'copy', size: 14 }), h('span', { key: 't' }, '复制')]),
          h('button', {
            key: 'pause',
            type: 'button',
            className: 'dp-tool',
            onClick: togglePause,
          }, state.paused ? '继续' : '暂停'),
          h('button', { key: 'close', type: 'button', className: 'dp-tool dp-tool--primary', onClick: onClose }, '关闭'),
        ],
      }, [
        h('div', { key: 'stats', className: 'dp-diff-stats' }, [
          state.paused
            ? h('span', { key: 'state', style: { color: C.muted } }, '已暂停（停止轮询）')
            : h('span', { key: 'state', className: 'dp-tail-live' }, [
                h('span', { key: 'dot', className: 'dp-dot dp-dot--on' }),
                '跟随中',
              ]),
          state.loading ? h(Spinner, { key: 'spin', label: '读取中…' }) : null,
          state.followedMs ? h('span', { key: 'followed', style: { color: C.muted } }, `本次 ${state.followedMs} ms`) : null,
          state.passes > 0 ? h('span', { key: 'passes', style: { color: C.muted } }, `刷新 ${state.passes} 次`) : null,
          state.truncated ? h('span', { key: 'trunc', style: { color: C.muted } }, '已截断') : null,
        ]),
        state.error ? h('div', { key: 'err', className: 'dp-banner', style: { margin: '0 12px 8px' } }, state.error) : null,
        h('div', { key: 'body', className: 'dp-modal-body', style: { overflow: 'hidden' } },
          h('pre', { key: 'pre', ref: preRef, className: 'dp-tail-pre' }, state.text || (state.loading ? '' : '（还没有输出）'))),
      ]);
    }

    /** Does this API error mean the host could not authenticate? */
    function isAuthMessage(text) {
      const message = String(text ?? '');
      return /authentication failed|no usable key|no password|password was supplied|Permission denied \(publickey|Host key verification failed/iu.test(message);
    }

    /** Split "host:port" typed into the address field; IPv6 needs brackets. */
    function splitHostPort(value, port) {
      const text = String(value ?? '').trim();
      let host = text;
      let finalPort = Number(port);
      const bracket = /^\[([^\]]+)\]:(\d{1,5})$/u.exec(text);
      const plain = !bracket && /^[^:]+:(\d{1,5})$/u.exec(text);
      if (bracket) {
        host = bracket[1];
        finalPort = Number(bracket[2]);
      } else if (plain) {
        host = text.slice(0, text.lastIndexOf(':'));
        finalPort = Number(plain[1]);
      }
      return {
        host: host || '127.0.0.1',
        port: Number.isInteger(finalPort) && finalPort > 0 && finalPort <= 65535 ? finalPort : null,
      };
    }

    /** Turn an ssh/tunnel failure into a title, a suggestion and the raw detail. */
    function tunnelErrorInfo(message) {
      const text = String(message ?? '');
      const listening = /nothing is listening on (\S+) on (\S+)/u.exec(text);
      if (listening) {
        return {
          title: `远程 ${listening[1]} 上没有服务在监听`,
          hint: `先在 ${listening[2]} 启动服务（或检查端口号），再点「开始转发」`,
          detail: '',
        };
      }
      if (isAuthMessage(text)) {
        return { title: '这台机器需要密码登录', hint: '先到右侧栏「远程文件」面板连接一次（可勾选记住），再回来转发', detail: '' };
      }
      if (/connection refused|ECONNREFUSED/iu.test(text)) {
        return { title: '连接被拒绝', hint: '检查远程 sshd 是否在运行、端口是否正确', detail: text };
      }
      if (/hostname could not be resolved|ENOTFOUND/iu.test(text)) {
        return { title: '主机名无法解析', hint: '检查 ssh config / 手动主机里的 HostName', detail: text };
      }
      if (/timed out|timeout/iu.test(text)) {
        return { title: '连接超时', hint: '网络不通或被防火墙拦截', detail: text };
      }
      return { title: '转发失败', hint: '检查远程服务是否在运行、端口是否写对', detail: text };
    }

    /** Save a URL through the native dialog when available, else a download link. */
    async function saveUrlAs(url, name) {
      try {
        if (typeof window.showSaveFilePicker === 'function') {
          const handle = await window.showSaveFilePicker({ suggestedName: name });
          const writable = await handle.createWritable();
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await response.body.pipeTo(writable);
          return true;
        }
      } catch (error) {
        if (error && error.name === 'AbortError') return false;
        if (error instanceof TypeError) return false; // picker unavailable: fall through
        throw error;
      }
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return true;
    }

    function saveRemoteFile(host, path, name) {
      return saveUrlAs(rawUrlFor(host, path, true), name);
    }

    /** Upload one File to a remote directory, reporting byte progress. */
    function uploadRemoteFile(host, dir, file, onProgress, nameOverride) {
      return new Promise((resolve, reject) => {
        const name = nameOverride ?? file.name;
        const query =
          `host=${encodeURIComponent(host)}&dir=${encodeURIComponent(dir)}` +
          `&name=${encodeURIComponent(name)}`;
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API}/upload?${query}`);
        xhr.responseType = 'json';
        xhr.upload.onprogress = (event) => {
          if (onProgress && event.lengthComputable) onProgress(event.loaded);
        };
        xhr.onload = () => {
          const data = xhr.response;
          if (xhr.status >= 200 && xhr.status < 300 && data && data.ok !== false) resolve(data);
          else reject(new Error((data && data.error) || `HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error('上传失败：网络错误'));
        xhr.send(file);
      });
    }

    async function mkdirRemote(host, path) {
      return request(`/mkdir?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`, {});
    }

    /** Recursively read a dropped/picked directory into a flat file list. */
    async function readEntryTree(entry, prefix, out) {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        out.push({ file, relative: prefix ? `${prefix}/${file.name}` : file.name });
        return;
      }
      if (!entry.isDirectory) return;
      const reader = entry.createReader();
      const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch || batch.length === 0) break;
        for (const child of batch) await readEntryTree(child, childPrefix, out);
      }
    }

    async function collectDroppedFiles(dataTransfer) {
      const out = [];
      const items = Array.from(dataTransfer.items ?? []);
      let usedEntries = false;
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry) {
          usedEntries = true;
          await readEntryTree(entry, '', out);
        } else {
          const file = item.getAsFile();
          if (file) out.push({ file, relative: file.name });
        }
      }
      if (!usedEntries && out.length === 0) {
        for (const file of Array.from(dataTransfer.files ?? [])) out.push({ file, relative: file.name });
      }
      return out;
    }

    /** Upload files (with folder structure) under `basePath`. */
    async function uploadFilesTree(host, basePath, items, onProgress) {
      const base = basePath.replace(/\/+$/u, '') || '/';
      const totalBytes = items.reduce((sum, item) => sum + (item.file.size ?? 0), 0);
      let sentBytes = 0;
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const parts = item.relative.split('/');
        const name = parts.pop();
        const relativeDir = parts.join('/');
        const dir = relativeDir ? `${base}/${relativeDir}` : base;
        if (relativeDir) await mkdirRemote(host, dir);
        onProgress?.({ done: index, total: items.length, bytes: sentBytes, totalBytes, current: item.relative });
        await uploadRemoteFile(host, dir, item.file, (loaded) => {
          onProgress?.({ done: index, total: items.length, bytes: sentBytes + loaded, totalBytes, current: item.relative });
        }, name);
        sentBytes += item.file.size ?? 0;
      }
      onProgress?.({ done: items.length, total: items.length, bytes: sentBytes, totalBytes, current: '' });
      return { files: items.length, bytes: sentBytes };
    }

    /**
     * Download a remote directory into a real local folder tree. The web layer
     * cannot drag a DIRECTORY out (Chromium's DownloadURL only carries one file),
     * so the equivalent of Xftp's "download folder" is picking a destination
     * folder and materialising the tree there.
     */
    async function downloadFolderTree(host, remotePath, name, onProgress) {
      if (typeof window.showDirectoryPicker !== 'function') {
        throw new Error('当前环境不支持选择本地文件夹（需要 File System Access API）');
      }
      let destination;
      try {
        destination = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (error) {
        // Closing the picker is a cancellation, not a failure.
        if (error && (error.name === 'AbortError' || error.name === 'SecurityError')) return null;
        throw error;
      }
      if (!destination) return null;
      const rootHandle = await destination.getDirectoryHandle(name, { create: true });
      const progress = { files: 0, bytes: 0, current: name };
      const walk = async (dirPath, handle) => {
        const data = await request(`/entries?host=${encodeURIComponent(host)}&path=${encodeURIComponent(dirPath)}`);
        for (const entry of data.entries ?? []) {
          if (entry.name === '.' || entry.name === '..') continue;
          if (entry.kind === 'dir') {
            const sub = await handle.getDirectoryHandle(entry.name, { create: true });
            await walk(entry.path, sub);
            continue;
          }
          progress.current = entry.path;
          onProgress?.({ ...progress });
          const fileHandle = await handle.getFileHandle(entry.name, { create: true });
          const writable = await fileHandle.createWritable();
          try {
            const response = await fetch(rawUrlFor(host, entry.path, true));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await response.body.pipeTo(writable);
          } catch (error) {
            await writable.abort?.().catch?.(() => {});
            throw new Error(`${entry.path}: ${error.message}`);
          }
          progress.files += 1;
          progress.bytes += entry.size ?? 0;
          onProgress?.({ ...progress });
        }
      };
      await walk(remotePath, rootHandle);
      return progress;
    }

    /**
     * The right-bar file browser: a remote directory pane that accepts dropped
     * files and folders (upload), previews images/text/code, and downloads
     * files or whole folders to disk.
     */
    function RemoteFilesPanel({ sessionId }) {
      const [hosts, setHosts] = useState([]);
      const [host, setHost] = useState(null);
      const [path, setPath] = useState('/');
      const [crumbs, setCrumbs] = useState([]);
      const [entries, setEntries] = useState([]);
      const [loading, setLoading] = useState(true);
      const [filter, setFilter] = useState('');
      const [dragOver, setDragOver] = useState(false);
      const [job, setJob] = useState(null);
      const [preview, setPreview] = useState(null);
      const [selected, setSelected] = useState(null);
      const [creatingFolder, setCreatingFolder] = useState(null);
      const [auth, setAuth] = useState(null);
      const [copied, setCopied] = useState(false);
      // 0.18 file context menu / prompt dialog / diff and tail viewers.
      const [menu, setMenu] = useState(null);
      const [dialog, setDialog] = useState(null);
      const [diffEntry, setDiffEntry] = useState(null);
      const [tailEntry, setTailEntry] = useState(null);
      const fileInput = useRef(null);
      const folderInput = useRef(null);
      const rootRef = useRef(null);
      const dropHandler = useRef(null);

      const load = useCallback(async (nextHost, nextPath) => {
        if (!nextHost) return;
        setLoading(true);
        notifyError(null);
        try {
          const query = `host=${encodeURIComponent(nextHost)}&path=${encodeURIComponent(nextPath)}`;
          const data = await request(`/entries?${query}`);
          setHost(nextHost);
          setPath(data.path);
          setCrumbs(data.crumbs ?? []);
          setEntries(data.entries ?? []);
          setSelected(null);
          setAuth(null);
        } catch (err) {
          // A password-only host cannot connect silently: ask instead of showing
          // the raw ssh failure.
          if (isAuthMessage(err.message)) {
            setEntries([]);
            setLoading(false);
            setAuth({ host: nextHost, path: nextPath, password: '', remember: false, error: null, busy: false });
            return;
          }
          notifyError(err.message);
        } finally {
          setLoading(false);
        }
      }, []);

      const submitPassword = async () => {
        if (!auth) return;
        setAuth({ ...auth, busy: true, error: null });
        try {
          await request('/connect', {
            host: auth.host,
            password: auth.password,
            remember: auth.remember,
          });
          const next = { host: auth.host, path: auth.path };
          setAuth(null);
          await load(next.host, next.path);
        } catch (err) {
          setAuth({ ...auth, busy: false, error: err.message });
        }
      };

      // First open: follow the session's workspace, else the first registered one.
      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const state = await request('/state');
            if (cancelled) return;
            setHosts(state.hosts ?? []);
            let target = null;
            if (sessionId) {
              try {
                const context = await request(`/context?sessionId=${encodeURIComponent(sessionId)}`);
                target = context.workspace ?? null;
              } catch {
                target = null;
              }
            }
            if (!target) {
              const listing = await request('/workspaces');
              target = (listing.workspaces ?? [])[0] ?? null;
            }
            if (cancelled) return;
            if (target) await load(target.host, target.path);
            else {
              setLoading(false);
              notifyError('还没有远程工作区：先到「设置 → Presence」新建一个。');
            }
          } catch (err) {
            if (!cancelled) {
              notifyError(err.message);
              setLoading(false);
            }
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [sessionId, load]);

      const visible = entries.filter((entry) => {
        if (!filter.trim()) return true;
        return entry.name.toLowerCase().includes(filter.trim().toLowerCase());
      });

      const startUpload = async (items) => {
        if (!items || items.length === 0) return;
        if (!host) {
          notifyError('还没有选择远程目录');
          return;
        }
        setJob({ kind: 'upload', label: `上传 0/${items.length}`, percent: 0, detail: '' });
        try {
          const result = await uploadFilesTree(host, path, items, (progress) => {
            setJob({
              kind: 'upload',
              label: `上传 ${progress.done}/${progress.total}`,
              percent: Math.round((progress.bytes / Math.max(1, progress.totalBytes)) * 100),
              detail: progress.current,
            });
          });
          setJob({ kind: 'done', label: `已上传 ${result.files} 个文件`, percent: 100, detail: humanSize(result.bytes) });
          notifySuccess(`已上传 ${result.files} 个文件`);
          await load(host, path);
          setTimeout(() => setJob(null), 2500);
        } catch (err) {
          notifyError(err.message);
          setJob(null);
        }
      };

      // Capture-phase drop handling: the chat composer also listens for drops on
      // the document, and without stopping propagation a dropped file both
      // uploads here AND attaches to the conversation.
      useEffect(() => {
        dropHandler.current = startUpload;
      });
      useEffect(() => {
        const inside = (event) => {
          const root = rootRef.current;
          return Boolean(root) && event.target instanceof Node && root.contains(event.target);
        };
        const onDragOver = (event) => {
          if (!inside(event)) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
          setDragOver(true);
        };
        const onDragLeave = (event) => {
          if (!inside(event)) return;
          event.stopPropagation();
          setDragOver(false);
        };
        const onDrop = (event) => {
          if (!inside(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setDragOver(false);
          const dataTransfer = event.dataTransfer;
          if (!dataTransfer) return;
          collectDroppedFiles(dataTransfer)
            .then((items) => dropHandler.current?.(items))
            .catch((err) => notifyError(err.message));
        };
        window.addEventListener('dragenter', onDragOver, true);
        window.addEventListener('dragover', onDragOver, true);
        window.addEventListener('dragleave', onDragLeave, true);
        window.addEventListener('drop', onDrop, true);
        return () => {
          window.removeEventListener('dragenter', onDragOver, true);
          window.removeEventListener('dragover', onDragOver, true);
          window.removeEventListener('dragleave', onDragLeave, true);
          window.removeEventListener('drop', onDrop, true);
        };
      }, []);

      // Escape closes the top-most layer: menu, prompt, diff, tail, then the
      // preview or the password prompt.
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          if (menu) setMenu(null);
          else if (dialog) setDialog(null);
          else if (diffEntry) setDiffEntry(null);
          else if (tailEntry) setTailEntry(null);
          else if (preview) setPreview(null);
          else if (auth) setAuth(null);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [preview, auth, menu, dialog, diffEntry, tailEntry]);

      const openEntry = async (entry) => {
        if (entry.kind === 'dir') {
          await load(host, entry.path);
          return;
        }
        const kind = previewKindOf(entry.name);
        if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf') {
          setPreview({
            name: entry.name,
            path: entry.path,
            size: entry.size,
            kind,
            url: rawUrlFor(host, entry.path, false),
          });
          return;
        }
        if (kind === 'code' || kind === 'text' || entry.size <= 256 * 1024) {
          try {
            setPreview({ name: entry.name, path: entry.path, size: entry.size, kind: 'loading' });
            const data = await request(`/file?host=${encodeURIComponent(host)}&path=${encodeURIComponent(entry.path)}`);
            setPreview({
              name: entry.name,
              path: entry.path,
              size: entry.size,
              kind: 'code',
              content: data.content,
              truncated: data.truncated,
              cap: data.cap,
            });
            return;
          } catch (err) {
            setPreview(null);
            notifyError(`${err.message}（将改用保存对话框）`);
          }
        }
        setPreview(null);
        await saveRemoteFile(host, entry.path, entry.name).catch((err) => notifyError(err.message));
      };

      const downloadEntry = async (entry) => {
        try {
          if (entry.kind === 'dir') {
            setJob({ kind: 'download', label: `下载文件夹 ${entry.name}`, percent: null, detail: '选择本地目标文件夹…' });
            const result = await downloadFolderTree(host, entry.path, entry.name, (progress) => {
              setJob({
                kind: 'download',
                label: `下载 ${progress.files} 个文件`,
                percent: null,
                detail: `${progress.current} · ${humanSize(progress.bytes)}`,
              });
            });
            if (result) {
              setJob({ kind: 'done', label: `已下载 ${result.files} 个文件`, percent: 100, detail: humanSize(result.bytes) });
              setTimeout(() => setJob(null), 2500);
            } else {
              setJob(null);
            }
            return;
          }
          await saveRemoteFile(host, entry.path, entry.name);
        } catch (err) {
          notifyError(err.message);
          setJob(null);
        }
      };

      const createFolder = async () => {
        const name = (creatingFolder ?? '').trim();
        if (!name) {
          setCreatingFolder(null);
          return;
        }
        const target = `${path.replace(/\/+$/u, '')}/${name}`;
        try {
          await mkdirRemote(host, target);
          setCreatingFolder(null);
          await load(host, path);
        } catch (err) {
          notifyError(err.message);
        }
      };

      const removeEntry = async (entry) => {
        if (!window.confirm(`把「${entry.name}」移到远端回收站？（可用 presence_trash 恢复）`)) return;
        try {
          await request(`/remove?host=${encodeURIComponent(host)}&path=${encodeURIComponent(entry.path)}`, {});
          await load(host, path);
          notifySuccess(t('toast.deleted'));
        } catch (err) {
          notifyError(err.message);
        }
      };

      // ------------------------------------------------ B2 file operations
      // All mutations go through the frozen POST /path-op shape:
      // { host, op, path, to?, mode?, recursive?, overwrite? }.
      const copyEntryPath = async (entry) => {
        try {
          await navigator.clipboard.writeText(entry.path);
          notifySuccess(t('toast.copiedPath'));
        } catch (err) {
          notifyError({ title: t('toast.copyFailed'), hint: t('toast.copyFailed.hint'), detail: err.message });
        }
      };

      const openPrompt = (kind, entry) => {
        if (kind === 'mkdir') {
          setDialog({ kind, entry, hint: `在 ${entry.path} 下创建`, placeholder: '文件夹名称', value: '', error: '', busy: false });
        } else if (kind === 'rename') {
          setDialog({ kind, entry, hint: entry.kind === 'dir' ? '重命名这个目录' : '重命名这个文件', placeholder: '新名称', value: remoteBaseName(entry.path), error: '', busy: false });
        } else {
          setDialog({ kind, entry, hint: '输入八进制权限，例如 755（目录）/ 644（文件）', placeholder: '755', value: entry.kind === 'dir' ? '755' : '644', error: '', busy: false });
        }
      };

      const submitPrompt = async () => {
        if (!dialog || dialog.busy) return;
        const entry = dialog.entry;
        const kind = dialog.kind;
        const value = String(dialog.value ?? '').trim();
        if (kind !== 'chmod' && !value) {
          setDialog({ ...dialog, error: '不能为空' });
          return;
        }
        if (kind === 'chmod' && normalizeOctalMode(value) === null) {
          setDialog({ ...dialog, error: '权限需要是八进制数字，例如 755 或 0644' });
          return;
        }
        setDialog({ ...dialog, busy: true, error: '' });
        let body;
        if (kind === 'mkdir') {
          body = { host, op: 'mkdir', path: joinRemotePath(entry.path, value) };
        } else if (kind === 'rename') {
          body = { host, op: 'rename', path: entry.path, to: joinRemotePath(parentRemotePath(entry.path), value) };
        } else {
          body = { host, op: 'chmod', path: entry.path, mode: normalizeOctalMode(value) };
        }
        try {
          await request('/path-op', body);
          setDialog(null);
          setMenu(null);
          await load(host, path);
          notifySuccess(kind === 'mkdir' ? t('toast.mkdirDone') : kind === 'rename' ? t('toast.renamed') : t('toast.chmodDone'));
        } catch (err) {
          const message = isMissingEndpointError(err.message)
            ? `${t('toast.unsupportedFeature')}：${t('toast.unsupportedFeature.hint')}`
            : err.message;
          setDialog((current) => (current ? { ...current, busy: false, error: message } : current));
        }
      };

      const isTailable = (entry) => {
        if (!entry || entry.kind === 'dir') return false;
        const kind = previewKindOf(entry.name);
        return kind === 'code' || kind === null;
      };

      const openMenu = (event, entry) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: event.clientX, y: event.clientY, entry });
      };

      const menuItemsFor = (entry) => {
        if (!entry) return [];
        const isDir = entry.kind === 'dir';
        return [
          isDir ? { key: 'mkdir', label: '新建文件夹', icon: 'folder-plus', onClick: () => openPrompt('mkdir', entry) } : null,
          { key: 'rename', label: '重命名', icon: 'text', onClick: () => openPrompt('rename', entry) },
          { key: 'copy', label: '复制路径', icon: 'copy', onClick: () => copyEntryPath(entry) },
          { key: 'chmod', label: '修改权限…', icon: 'lock', onClick: () => openPrompt('chmod', entry) },
          { key: 'sep1', separator: true },
          isDir ? null : { key: 'diff', label: '对比差异…', icon: 'text', onClick: () => setDiffEntry(entry) },
          isTailable(entry) ? { key: 'tail', label: '查看日志…', icon: 'code', onClick: () => setTailEntry(entry) } : null,
          { key: 'sep2', separator: true },
          { key: 'delete', label: '移到回收站', icon: 'trash', danger: true, onClick: () => removeEntry(entry) },
        ].filter(Boolean);
      };

      const rowActions = (entry) => h('span', { key: 'actions', className: 'dp-factions' }, [
        h('button', {
          key: 'save',
          type: 'button',
          className: 'dp-iconbtn',
          title: entry.kind === 'dir' ? '下载文件夹到本地' : '保存到本地',
          onClick: (event) => {
            event.stopPropagation();
            downloadEntry(entry);
          },
        }, h(Icon, { name: 'download', size: 15 })),
        h('button', {
          key: 'delete',
          type: 'button',
          className: 'dp-iconbtn',
          title: '移到回收站',
          onClick: (event) => {
            event.stopPropagation();
            removeEntry(entry);
          },
        }, h(Icon, { name: 'trash', size: 15 })),
        h('button', {
          key: 'menu',
          type: 'button',
          className: 'dp-iconbtn',
          title: '更多操作（也可以右键这一行）',
          onClick: (event) => {
            event.stopPropagation();
            setMenu({ x: event.clientX, y: event.clientY, entry });
          },
        }, h(Icon, { name: 'more', size: 15 })),
      ]);

      return h('div', {
        ref: rootRef,
        className: 'dp-pane',
        style: { position: 'relative', flex: '1 1 auto', minHeight: 0, height: '100%' },
      }, [
        h('div', { key: 'toolbar', className: 'dp-toolbar' }, [
          h('span', { key: 'host-icon', className: 'dp-toolbar-icon' }, h(Icon, { name: 'server', size: 15 })),
          h('select', {
            key: 'host',
            className: 'dp-select',
            value: host ?? '',
            onChange: (event) => {
              const next = event.target.value;
              if (next) load(next, '/');
            },
          }, hosts.map((item) => h('option', { key: item.alias, value: item.alias }, item.alias))),
          h('div', { key: 'spacer', style: { flex: 1 } }),
          h('button', {
            key: 'upload-file',
            type: 'button',
            className: 'dp-tool',
            title: '上传文件',
            onClick: () => fileInput.current?.click(),
          }, [h(Icon, { key: 'i', name: 'upload', size: 15 }), h('span', { key: 't' }, '文件')]),
          h('button', {
            key: 'upload-folder',
            type: 'button',
            className: 'dp-tool',
            title: '上传文件夹',
            onClick: () => folderInput.current?.click(),
          }, [h(Icon, { key: 'i', name: 'folder', size: 15 }), h('span', { key: 't' }, '文件夹')]),
          h('button', {
            key: 'mkdir',
            type: 'button',
            className: 'dp-tool',
            title: '新建文件夹',
            onClick: () => setCreatingFolder(''),
          }, [h(Icon, { key: 'i', name: 'folder-plus', size: 15 })]),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dp-tool',
            title: '刷新',
            onClick: () => load(host, path),
          }, [h(Icon, { key: 'i', name: 'refresh', size: 15 })]),
          h('input', {
            key: 'file-input',
            ref: fileInput,
            type: 'file',
            multiple: true,
            style: { display: 'none' },
            onChange: async (event) => {
              const files = Array.from(event.target.files ?? []).map((file) => ({ file, relative: file.name }));
              event.target.value = '';
              await startUpload(files);
            },
          }),
          h('input', {
            key: 'folder-input',
            ref: folderInput,
            type: 'file',
            multiple: true,
            webkitdirectory: 'true',
            directory: 'true',
            style: { display: 'none' },
            onChange: async (event) => {
              const files = Array.from(event.target.files ?? []);
              const items = files.map((file) => ({
                file,
                relative: (file.webkitRelativePath || file.name).replace(/\\/gu, '/'),
              }));
              event.target.value = '';
              await startUpload(items);
            },
          }),
        ]),
        h('div', { key: 'pathbar', className: 'dp-path' },
          crumbs.map((crumb, index) => h('span', { key: `${crumb.path}#${index}`, className: 'dp-path-part' }, [
            index > 0
              ? h('span', { key: 'sep', className: 'dp-path-sep' }, h(Icon, { name: 'chevron', size: 12 }))
              : null,
            h('button', {
              key: 'crumb',
              type: 'button',
              className: index === crumbs.length - 1 ? 'dp-crumb dp-crumb--current' : 'dp-crumb',
              onClick: () => load(host, crumb.path),
            }, index === 0 ? '/' : crumb.name),
          ]))),
        h('div', { key: 'filter', className: 'dp-filter' }, [
          h('span', { key: 'icon', className: 'dp-filter-icon' }, h(Icon, { name: 'search', size: 14 })),
          h('input', {
            key: 'input',
            className: 'dp-input',
            value: filter,
            placeholder: '筛选当前目录…',
            onChange: (event) => setFilter(event.target.value),
          }),
        ]),
        creatingFolder !== null
          ? h('div', { key: 'newfolder', className: 'dp-newfolder' }, [
              h('input', {
                key: 'name',
                className: 'dp-input',
                autoFocus: true,
                placeholder: '文件夹名称',
                value: creatingFolder,
                onChange: (event) => setCreatingFolder(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') createFolder();
                  if (event.key === 'Escape') setCreatingFolder(null);
                },
              }),
              h('button', { key: 'create', type: 'button', className: 'dp-tool dp-tool--primary', onClick: createFolder }, '创建'),
            ])
          : null,
        h('div', { key: 'columns', className: 'dp-columns' }, [
          h('span', { key: 'name', className: 'dp-col-name' }, '名称'),
          h('span', { key: 'size', className: 'dp-col-size' }, '大小'),
          h('span', { key: 'time', className: 'dp-col-time' }, '修改时间'),
          h('span', { key: 'actions', className: 'dp-col-actions' }),
        ]),
        h('div', { key: 'list', className: 'dp-list' },
          loading
            ? h('div', { className: 'dp-loading' }, h(Spinner, { label: '加载中…' }))
            : visible.length === 0
              ? h('div', { key: 'empty', className: 'dp-empty' }, [
                  h('span', { key: 'icon', className: 'dp-empty-icon' }, h(Icon, { name: filter.trim() ? 'search' : 'folder', size: 22 })),
                  h('span', { key: 'text' }, filter.trim() ? '没有匹配的条目' : '这个目录是空的'),
                ])
              : visible.map((entry) => h('div', {
                  key: entry.path,
                  className: `dp-entry${selected === entry.path ? ' is-selected' : ''}`,
                  role: 'button',
                  tabIndex: 0,
                  title: entry.kind === 'dir' ? `${entry.path}（双击进入，↓ 下载文件夹，右键更多操作）` : `${entry.path}（双击预览，右键更多操作）`,
                  onContextMenu: (event) => openMenu(event, entry),
                  draggable: entry.kind !== 'dir',
                  onDragStart: (event) => {
                    if (entry.kind === 'dir') return;
                    try {
                      event.dataTransfer.setData(
                        'DownloadURL',
                        `application/octet-stream:${entry.name}:${new URL(rawUrlFor(host, entry.path, true), window.location.href).href}`,
                      );
                      event.dataTransfer.effectAllowed = 'copy';
                    } catch {
                      /* the OS may refuse; the ↓ button still works */
                    }
                  },
                  onClick: () => setSelected(entry.path),
                  onDoubleClick: () => openEntry(entry),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') openEntry(entry);
                  },
                }, [
                  h('span', { key: 'icon', className: `dp-tile dp-tile--${entry.kind}` }, h(Icon, { name: entryIconName(entry), size: 16 })),
                  h('span', { key: 'name', className: 'dp-name' }, entry.name),
                  h('span', { key: 'size', className: 'dp-meta dp-col-size' }, entry.kind === 'dir' ? '—' : humanSize(entry.size)),
                  h('span', { key: 'time', className: 'dp-meta dp-col-time' }, formatMoment(entry.mtime)),
                  rowActions(entry),
                ]))),
        dragOver
          ? h('div', { key: 'drop', className: 'dp-drop' }, [
              h(Icon, { key: 'i', name: 'upload', size: 22 }),
              h('span', { key: 't' }, `松开上传到 ${path}`),
            ])
          : null,
        job
          ? h('div', { key: 'job', className: 'dp-progress' }, [
              h('div', { key: 'head', className: 'dp-progress-head' }, [
                h(Icon, { key: 'i', name: job.kind === 'done' ? 'check' : 'download', size: 13 }),
                h('span', { key: 'label', className: 'dp-progress-label' }, job.label),
                job.kind === 'done'
                  ? h('span', { key: 'ok', className: 'dp-progress-ok' }, job.detail)
                  : h('span', { key: 'pct' }, job.percent === null ? '' : `${job.percent}%`),
              ]),
              h('div', { key: 'track', className: 'dp-progress-track' },
                h('div', {
                  key: 'fill',
                  className: job.percent === null ? 'dp-progress-fill is-indeterminate' : 'dp-progress-fill',
                  style: { width: `${job.percent ?? 40}%` },
                })),
              job.detail && job.kind !== 'done'
                ? h('div', { key: 'detail', className: 'dp-progress-detail' }, job.detail)
                : null,
            ])
          : null,
        auth
          ? h('div', {
              key: 'auth-overlay',
              className: 'dp-overlay',
              onClick: () => setAuth(null),
            }, h('div', {
              key: 'auth',
              className: 'dp-auth',
              onClick: (event) => event.stopPropagation(),
            }, [
              h('div', { key: 'head', className: 'dp-auth-head' }, [
                h('span', { key: 'icon', className: 'dp-auth-icon' }, h(Icon, { name: 'lock', size: 18 })),
                h('span', { key: 'title', className: 'dp-auth-title' }, `连接 ${auth.host}`),
              ]),
              h('div', { key: 'hint', className: 'dp-auth-hint' },
                '这台机器需要密码登录。密码默认只保存在内存里，勾选「记住这台」才会交给凭据服务保管。'),
              h('input', {
                key: 'password',
                className: 'dp-input',
                type: 'password',
                autoFocus: true,
                placeholder: 'SSH 密码',
                value: auth.password,
                onChange: (event) => setAuth({ ...auth, password: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submitPassword();
                  if (event.key === 'Escape') setAuth(null);
                },
              }),
              h('label', { key: 'remember', className: 'dp-auth-row' }, [
                h('input', {
                  key: 'cb',
                  type: 'checkbox',
                  checked: auth.remember,
                  onChange: (event) => setAuth({ ...auth, remember: event.target.checked }),
                }),
                h('span', { key: 't' }, '记住这台'),
              ]),
              auth.error
                ? h('div', { key: 'err', className: 'dp-banner', style: { margin: 0 } },
                    h('div', { key: 'body', className: 'dp-banner-body' }, [
                      h('span', { key: 'title', className: 'dp-banner-title' }, humanizeError(auth.error).title),
                      h('span', { key: 'hint', className: 'dp-banner-hint' }, humanizeError(auth.error).hint || humanizeError(auth.error).detail),
                    ]))
                : null,
              h('div', { key: 'actions', className: 'dp-auth-actions' }, [
                h('button', { key: 'cancel', type: 'button', className: 'dp-tool', onClick: () => setAuth(null) }, '取消'),
                h('button', {
                  key: 'connect',
                  type: 'button',
                  className: 'dp-tool dp-tool--primary',
                  disabled: auth.busy || !auth.password,
                  onClick: submitPassword,
                }, auth.busy ? '连接中…' : '连接'),
              ]),
            ]))
          : null,
        preview
          ? h('div', {
              key: 'overlay',
              className: 'dp-overlay',
              onClick: () => setPreview(null),
            }, h('div', {
              key: 'modal',
              className: 'dp-modal',
              onClick: (event) => event.stopPropagation(),
            }, [
              h('div', { key: 'head', className: 'dp-modal-head' }, [
                h('span', { key: 'icon', className: 'dp-modal-icon' }, h(Icon, {
                  name: entryIconName({ kind: 'file', name: preview.name }),
                  size: 16,
                })),
                h('span', {
                  key: 'name',
                  className: 'dp-modal-title',
                  style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                }, preview.name),
                preview.kind === 'code'
                  ? h('span', { key: 'chip', className: 'dp-chip' }, extensionOf(preview.name).toUpperCase() || 'TEXT')
                  : preview.kind === 'image'
                    ? h('span', { key: 'chip', className: 'dp-chip' }, '图片')
                    : preview.kind === 'video'
                      ? h('span', { key: 'chip', className: 'dp-chip' }, '视频')
                      : preview.kind === 'audio'
                        ? h('span', { key: 'chip', className: 'dp-chip' }, '音频')
                        : preview.kind === 'pdf'
                          ? h('span', { key: 'chip', className: 'dp-chip' }, 'PDF')
                          : null,
                preview.kind === 'code'
                  ? h('button', {
                      key: 'copy',
                      type: 'button',
                      className: 'dp-tool',
                      title: '复制全部内容',
                      onClick: async () => {
                        try {
                          await navigator.clipboard.writeText(preview.content ?? '');
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        } catch (err) {
                          notifyError(`复制失败：${err.message}`);
                        }
                      },
                    }, [h(Icon, { key: 'i', name: 'copy', size: 14 }), h('span', { key: 't' }, copied ? '已复制' : '复制')])
                  : null,
                h('span', { key: 'size', className: 'dp-meta' }, humanSize(preview.size)),
                h('button', {
                  key: 'close',
                  type: 'button',
                  className: 'dp-iconbtn',
                  title: '关闭 (Esc)',
                  onClick: () => setPreview(null),
                }, h(Icon, { name: 'x', size: 16 })),
              ]),
              preview.truncated
                ? h('div', {
                    key: 'truncbanner',
                    className: 'dp-banner',
                    style: { margin: '10px 12px 0' },
                  }, `文件较大：只预览了前 ${humanSize(preview.cap ?? 1024 * 1024)}（完整 ${humanSize(preview.size)}）。要看全部请「保存到本地」。`)
                : null,
              h('div', { key: 'body', className: 'dp-modal-body' },
                preview.kind === 'loading'
                  ? h('div', { className: 'dp-loading' }, h(Spinner, { label: '读取中…' }))
                  : preview.kind === 'image'
                    ? h('img', { key: 'img', src: preview.url, className: 'dp-preview-image' })
                    : preview.kind === 'video'
                      ? h('video', {
                          key: 'video',
                          src: preview.url,
                          controls: true,
                          autoPlay: false,
                          className: 'dp-media',
                        })
                      : preview.kind === 'audio'
                        ? h('div', { key: 'audio', className: 'dp-audio-wrap' }, h('audio', {
                            src: preview.url,
                            controls: true,
                            autoPlay: false,
                            className: 'dp-media',
                          }))
                        : preview.kind === 'pdf'
                          ? h('iframe', {
                              key: 'pdf',
                              src: preview.url,
                              title: preview.name,
                              className: 'dp-pdf',
                            })
                          : preview.kind === 'code'
                            ? h(CodeView, { content: preview.content, name: preview.name })
                            : h('pre', { className: 'dp-plain' }, preview.content ?? '')),
              h('div', { key: 'foot', className: 'dp-modal-foot' }, [
                h('span', { key: 'path', className: 'dp-modal-path' }, preview.path),
                preview.truncated ? h('span', { key: 'trunc', className: 'dp-meta' }, '已截断') : null,
                h('button', {
                  key: 'save',
                  type: 'button',
                  className: 'dp-tool dp-tool--primary',
                  onClick: () => saveRemoteFile(host, preview.path, preview.name).catch((err) => notifyError(err.message)),
                }, [h(Icon, { key: 'i', name: 'download', size: 15 }), h('span', { key: 't' }, '保存到本地')]),
              ]),
            ]))
          : null,
        // ------------------------------------------------- 0.18 layers
        menu
          ? h(ContextMenu, {
              key: 'menu',
              x: menu.x,
              y: menu.y,
              title: menu.entry.path,
              items: menuItemsFor(menu.entry),
              onClose: () => setMenu(null),
            })
          : null,
        dialog
          ? h(PromptDialog, {
              key: 'prompt',
              title: dialog.kind === 'mkdir' ? '新建文件夹' : dialog.kind === 'rename' ? '重命名' : '修改权限',
              path: dialog.kind === 'mkdir' ? joinRemotePath(dialog.entry.path, '…') : dialog.entry.path,
              hint: dialog.hint,
              value: dialog.value,
              placeholder: dialog.placeholder,
              error: dialog.error,
              busy: dialog.busy,
              inputMode: dialog.kind === 'chmod' ? 'numeric' : undefined,
              onChange: (value) => setDialog((current) => (current ? { ...current, value, error: '' } : current)),
              onSubmit: submitPrompt,
              onCancel: () => setDialog(null),
            })
          : null,
        diffEntry
          ? h(DiffModal, {
              key: 'diff',
              host,
              path: diffEntry.path,
              onClose: () => setDiffEntry(null),
            })
          : null,
        tailEntry
          ? h(TailModal, {
              key: 'tail',
              host,
              path: tailEntry.path,
              name: tailEntry.name,
              onClose: () => setTailEntry(null),
            })
          : null,
      ]);
    }

    // ------------------------------------------------- D2 port discovery
    // Ignored ports are a UI preference (not server state), so they live in
    // localStorage per host. `discoveryAnnounced` dedupes the "new port" toast
    // across panel re-mounts; the host also reports `new`, but its cache is
    // short-lived so a reopen could otherwise re-announce the same port.
    const DISMISSED_PORTS_KEY = 'presence.dismissedPorts';
    const discoveryAnnounced = new Set();

    function readDismissedPorts() {
      try {
        const raw = window.localStorage.getItem(DISMISSED_PORTS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }

    function writeDismissedPorts(value) {
      try {
        window.localStorage.setItem(DISMISSED_PORTS_KEY, JSON.stringify(value));
      } catch {
        /* storage disabled: dismissal only lasts for this page */
      }
    }

    /**
     * Port forwards: remote services exposed on 127.0.0.1 locally. The registry
     * is shared with the agent's presence_forward tool, so tunnels opened from a
     * session or from this panel both show up here. Styling follows the file
     * browser: theme tokens only (no ad-hoc colours), 4px grid, icon buttons.
     */
    function TunnelPanel({ sessionId }) {
      const [hosts, setHosts] = useState([]);
      const [tunnels, setTunnels] = useState([]);
      const [host, setHost] = useState('');
      const [remoteHost, setRemoteHost] = useState('127.0.0.1');
      const [remotePort, setRemotePort] = useState('');
      const [localPort, setLocalPort] = useState('');
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [copied, setCopied] = useState(null);
      // D1: saved forwards + "auto restore after reconnect" for this open.
      const [presets, setPresets] = useState([]);
      const [presetsSupported, setPresetsSupported] = useState(false);
      const [autoRestore, setAutoRestore] = useState(false);
      const [presetLabel, setPresetLabel] = useState('');
      // D2: discovered-but-unforwarded ports for the selected host.
      const [discovered, setDiscovered] = useState(null);
      const [discoverySupported, setDiscoverySupported] = useState(true);
      const [portBusy, setPortBusy] = useState(null);
      const [dismissedPorts, setDismissedPorts] = useState(() => readDismissedPorts());

      const load = useCallback(async () => {
        try {
          const [state, listing] = await Promise.all([request('/state'), request('/tunnels')]);
          const list = state.hosts ?? [];
          setHosts(list);
          setTunnels(listing.tunnels ?? []);
          // Older hosts answer { ok, tunnels } without the presets field: hide
          // the auto-restore UI instead of showing an empty broken section.
          const hasPresets = Array.isArray(listing.presets);
          setPresetsSupported(hasPresets);
          if (hasPresets) setPresets(listing.presets);
          notifyError(null);
          setHost((current) => current || list.find((item) => item.connected)?.alias || list[0]?.alias || '');
        } catch (err) {
          notifyError(tunnelErrorInfo(err.message));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        let cancelled = false;
        (async () => {
          await load();
          if (cancelled || !sessionId) return;
          try {
            const context = await request(`/context?sessionId=${encodeURIComponent(sessionId)}`);
            if (!cancelled && context.workspace?.host) {
              setHost((current) => current || context.workspace.host);
            }
          } catch {
            /* no session context: keep the default host */
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [sessionId, load]);

      // The agent may open tunnels too; poll so this list stays truthful.
      useEffect(() => {
        const timer = setInterval(() => { load(); }, 4000);
        return () => clearInterval(timer);
      }, [load]);

      // D2: while this panel is open, ask the host for listening ports every
      // 8 s. The host caches the scan (<=5 s), so refresh=1 is cheap; a missing
      // or failing endpoint silently disables the section instead of nagging.
      useEffect(() => {
        if (!discoverySupported) return undefined;
        const wantedHost = String(host ?? '').trim();
        if (!wantedHost) return undefined;
        let disposed = false;
        let timer = null;
        const tick = async () => {
          if (disposed) return;
          try {
            const data = await request(`/discover?host=${encodeURIComponent(wantedHost)}&refresh=1`);
            if (disposed) return;
            const ports = Array.isArray(data.ports) ? data.ports : [];
            setDiscovered({ host: wantedHost, ports, at: Date.now() });
            const dismissed = new Set((readDismissedPorts()[wantedHost] ?? []).map(Number));
            const forwarded = new Set(
              ports.filter((item) => item?.forwarded).map((item) => Number(item?.port)),
            );
            const fresh = [];
            for (const raw of Array.isArray(data.new) ? data.new : []) {
              const port = Number(raw && typeof raw === 'object' ? raw.port : raw);
              if (!Number.isInteger(port)) continue;
              const key = `${wantedHost}:${port}`;
              if (dismissed.has(port) || forwarded.has(port) || discoveryAnnounced.has(key)) continue;
              discoveryAnnounced.add(key);
              fresh.push(port);
            }
            if (fresh.length > 0) {
              const label = fresh.slice(0, 4).map((port) => `:${port}`).join(' ');
              notifyInfo({
                title: t('toast.discovered', { count: fresh.length }),
                hint: `${label} · ${t('toast.discovered.hint')}`,
              }, { dedupeKey: `discover:${wantedHost}:${fresh.join(',')}` });
            }
          } catch (err) {
            // Only a host without the route disables the section; a transient
            // failure (host disconnected, password prompt pending) just retries
            // on the next 8 s tick.
            if (!disposed && isMissingEndpointError(err.message)) setDiscoverySupported(false);
          } finally {
            if (!disposed) timer = setTimeout(tick, 8000);
          }
        };
        tick();
        return () => {
          disposed = true;
          if (timer) clearTimeout(timer);
          timer = null;
        };
      }, [host, discoverySupported]);

      const startTunnel = async () => {
        if (busy) return;
        if (!host) {
          notifyError({ title: '先选一台机器', hint: '在上面的「机器」下拉框里选一台远程机器' });
          return;
        }
        const split = splitHostPort(remoteHost, remotePort);
        if (!split.port) {
          notifyError({ title: '远程端口无效', hint: '填写 1-65535 的端口号，例如 8000 / 6000 / 3000' });
          return;
        }
        if (split.host !== remoteHost.trim()) setRemoteHost(split.host);
        const wantedLocal = localPort.trim() ? Number(localPort.trim()) : undefined;
        if (wantedLocal !== undefined && (!Number.isInteger(wantedLocal) || wantedLocal < 1 || wantedLocal > 65535)) {
          notifyError({ title: '本地端口无效', hint: '留空表示与远程端口相同；手填时需为 1-65535' });
          return;
        }
        setBusy(true);
        notifyError(null);
        try {
          // D1: keep:true asks the host to remember the forward, autoRestore
          // reopens it after the next reconnect. Older hosts ignore the extra
          // fields (and we hide the UI when they do not advertise presets).
          const wantsPreset = presetsSupported && (autoRestore || presetLabel.trim().length > 0);
          const payload = {
            host,
            remotePort: split.port,
            remoteHost: split.host,
            localPort: wantedLocal,
          };
          if (wantsPreset) {
            payload.keep = true;
            payload.autoRestore = autoRestore;
            const label = presetLabel.trim();
            if (label) payload.label = label;
          }
          const created = await request('/tunnels', payload);
          setRemotePort('');
          setLocalPort('');
          if (wantsPreset) setPresetLabel('');
          const tunnel = created.tunnel ?? {};
          await load();
          if (wantsPreset) {
            notifySuccess(autoRestore ? t('toast.presetSaved') : t('toast.presetKept'));
          } else if (tunnel.localPortFallback) {
            notifyWarning(`本地 ${tunnel.requestedLocalPort} 已被占用，已改用 ${tunnel.localPort}；可在「本地端口」里手动指定`);
          } else {
            notifySuccess(`端口转发已建立：${tunnel.url ?? ''}`);
          }
        } catch (err) {
          notifyError(tunnelErrorInfo(err.message));
        } finally {
          setBusy(false);
        }
      };

      const stopTunnel = async (id) => {
        try {
          await request(`/tunnels?id=${encodeURIComponent(id)}`, undefined, 'DELETE');
          await load();
          notifySuccess('端口转发已停止');
        } catch (err) {
          notifyError(tunnelErrorInfo(err.message));
        }
      };

      const copyUrl = async (tunnel) => {
        try {
          await navigator.clipboard.writeText(tunnel.url);
          setCopied(tunnel.id);
          setTimeout(() => setCopied(null), 1500);
          notifySuccess('已复制到剪贴板');
        } catch (err) {
          notifyError({ title: '复制失败', hint: '浏览器拒绝了剪贴板操作，可以手动选中 URL 复制', detail: err.message });
        }
      };

      // -------------------------------------------------- D1 presets (MUT)
      const unsupportedError = () => ({
        title: t('toast.unsupportedFeature'),
        hint: t('toast.unsupportedFeature.hint'),
      });

      const updatePreset = async (preset, patch) => {
        const nextAutoRestore = patch.autoRestore ?? Boolean(preset.autoRestore);
        // Optimistic: a controlled checkbox that waits for the PUT would snap
        // back for a frame. Revert (and resync) if the request fails.
        setPresets((current) => current.map((item) => (
          String(item.id) === String(preset.id) ? { ...item, autoRestore: nextAutoRestore } : item
        )));
        try {
          const data = await request('/tunnels/preset', {
            host: preset.host,
            remoteHost: preset.remoteHost ?? '127.0.0.1',
            remotePort: preset.remotePort,
            localPort: preset.localPort ?? preset.remotePort,
            label: preset.label ?? undefined,
            autoRestore: nextAutoRestore,
          }, 'PUT');
          if (data.preset) {
            setPresets((current) => current.map((item) => (
              String(item.id) === String(preset.id) ? data.preset : item
            )));
          }
          notifySuccess(t('toast.presetUpdated'));
        } catch (err) {
          setPresets((current) => current.map((item) => (
            String(item.id) === String(preset.id) ? { ...item, autoRestore: Boolean(preset.autoRestore) } : item
          )));
          notifyError(isMissingEndpointError(err.message) ? unsupportedError() : tunnelErrorInfo(err.message));
        }
      };

      const deletePreset = async (preset) => {
        try {
          const query = new URLSearchParams({
            host: String(preset.host ?? ''),
            remoteHost: String(preset.remoteHost ?? '127.0.0.1'),
            remotePort: String(preset.remotePort ?? ''),
          });
          await request(`/tunnels/preset?${query.toString()}`, undefined, 'DELETE');
          await load();
          notifySuccess(t('toast.presetRemoved'));
        } catch (err) {
          notifyError(isMissingEndpointError(err.message) ? unsupportedError() : tunnelErrorInfo(err.message));
        }
      };

      const openPreset = async (preset) => {
        setBusy(true);
        try {
          await request('/tunnels', {
            host: preset.host,
            remotePort: preset.remotePort,
            remoteHost: preset.remoteHost ?? '127.0.0.1',
            localPort: preset.localPort ?? undefined,
          });
          await load();
          notifySuccess('端口转发已建立');
        } catch (err) {
          notifyError(tunnelErrorInfo(err.message));
        } finally {
          setBusy(false);
        }
      };

      const isPresetOpen = (preset) => tunnels.some((tunnel) => (
        tunnel.host === preset.host
        && Number(tunnel.remotePort) === Number(preset.remotePort)
        && (tunnel.remoteHost ?? '127.0.0.1') === (preset.remoteHost ?? '127.0.0.1')
      ));

      // ------------------------------------------- D2 discovery actions (MUT)
      const dismissedForHost = new Set((dismissedPorts[host] ?? []).map(Number));
      // `ss` can list the same port once per bind address (0.0.0.0 + [::]);
      // show one chip per port number.
      const discoveredVisible = [];
      const seenDiscovered = new Set();
      for (const item of (discovered && discovered.host === host ? discovered.ports : [])) {
        const numeric = Number(item?.port);
        if (!Number.isInteger(numeric) || seenDiscovered.has(numeric)) continue;
        seenDiscovered.add(numeric);
        if (item.forwarded || dismissedForHost.has(numeric)) continue;
        discoveredVisible.push(item);
        if (discoveredVisible.length >= 10) break;
      }

      const dismissPort = (port) => {
        const numeric = Number(port);
        const current = readDismissedPorts();
        const list = new Set((current[host] ?? []).map(Number));
        list.add(numeric);
        current[host] = [...list];
        writeDismissedPorts(current);
        setDismissedPorts(current);
      };

      const forwardDiscovered = async (item) => {
        const numeric = Number(item?.port);
        if (!Number.isInteger(numeric)) return;
        const address = String(item?.address ?? '').trim();
        const target = !address || address === '0.0.0.0' || address === '::' || address === '[::]'
          ? '127.0.0.1'
          : address;
        setPortBusy(numeric);
        try {
          await request('/tunnels', { host, remotePort: numeric, remoteHost: target });
          // Reflect the forward immediately instead of waiting for the next
          // 8 s discovery scan (and avoid opening the same port twice).
          setDiscovered((current) => (current && current.host === host
            ? {
                ...current,
                ports: current.ports.map((entry) => (
                  Number(entry?.port) === numeric ? { ...entry, forwarded: true } : entry
                )),
              }
            : current));
          await load();
          notifySuccess(`端口转发已建立：127.0.0.1:${numeric}`);
        } catch (err) {
          notifyError(tunnelErrorInfo(err.message));
        } finally {
          setPortBusy(null);
        }
      };

      const groups = [...tunnels.reduce((map, tunnel) => {
        if (!map.has(tunnel.host)) map.set(tunnel.host, []);
        map.get(tunnel.host).push(tunnel);
        return map;
      }, new Map())].sort((a, b) => a[0].localeCompare(b[0]));

      const hostConnected = (alias) => Boolean(hosts.find((item) => item.alias === alias)?.connected);

      const tunnelRow = (tunnel) => h('div', {
        key: tunnel.id,
        className: 'dp-entry dp-entry--tunnel',
      }, [
        h('span', { key: 'icon', className: 'dp-tile dp-tile--live' }, h(Icon, { name: 'external', size: 16 })),
        h('div', { key: 'text', className: 'dp-tunnel-text' }, [
          h('div', { key: 'route', className: 'dp-tunnel-route dp-mono' }, [
            `${tunnel.remoteHost}:${tunnel.remotePort}`,
            h('span', { key: 'arrow', className: 'dp-tunnel-arrow' }, '→'),
            `127.0.0.1:${tunnel.localPort}`,
          ]),
          h('a', {
            key: 'url',
            className: 'dp-tunnel-url dp-mono',
            href: tunnel.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            title: '在浏览器里打开',
          }, tunnel.url),
        ]),
        h('div', { key: 'actions', className: 'dp-tunnel-actions' }, [
          h('a', {
            key: 'open',
            className: 'dp-iconbtn',
            href: tunnel.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            title: '打开',
          }, h(Icon, { name: 'external', size: 15 })),
          h('button', {
            key: 'copy',
            type: 'button',
            className: 'dp-iconbtn',
            title: copied === tunnel.id ? '已复制' : '复制 URL',
            onClick: () => copyUrl(tunnel),
          }, h(Icon, { name: copied === tunnel.id ? 'check' : 'copy', size: 15 })),
          h('button', {
            key: 'stop',
            type: 'button',
            className: 'dp-iconbtn dp-iconbtn--danger',
            title: '停止转发',
            onClick: () => stopTunnel(tunnel.id),
          }, h(Icon, { name: 'power', size: 15 })),
        ]),
      ]);

      return h('div', {
        className: 'dp-pane',
        style: { height: '100%', minHeight: 0 },
      }, [
        h('div', { key: 'toolbar', className: 'dp-toolbar' }, [
          h('span', { key: 'icon', className: 'dp-toolbar-icon' }, h(Icon, { name: 'server', size: 15 })),
          h('span', { key: 'title', className: 'dp-toolbar-title' }, '端口转发'),
          tunnels.length > 0
            ? h('span', { key: 'count', className: 'dp-group-chip' }, `${tunnels.length} 个`)
            : null,
          h('div', { key: 'spacer', style: { flex: 1 } }),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dp-tool',
            title: '刷新',
            onClick: load,
          }, h('span', { key: 'spin', className: loading ? 'dp-spin-wrap dp-spinning' : 'dp-spin-wrap' }, h(Icon, { name: 'refresh', size: 15 }))),
        ]),
        h('div', { key: 'form', className: 'dp-form' }, [
          h('div', { key: 'host', className: 'dp-field', style: { flex: '1 1 100%' } }, [
            h('label', { key: 'label', className: 'dp-field-label' }, '机器'),
            h('select', {
              key: 'select',
              className: 'dp-select',
              value: host,
              onChange: (event) => setHost(event.target.value),
            }, hosts.map((item) => h('option', { key: item.alias, value: item.alias },
              item.connected ? `${item.alias}（已连接）` : item.alias))),
          ]),
          h('div', { key: 'row', className: 'dp-form-row' }, [
            h('div', { key: 'remoteHost', className: 'dp-field dp-field--host' }, [
              h('label', { key: 'label', className: 'dp-field-label' }, '远程主机'),
              h('input', {
                key: 'input',
                className: 'dp-input dp-mono',
                value: remoteHost,
                placeholder: '127.0.0.1',
                onChange: (event) => setRemoteHost(event.target.value),
              }),
            ]),
            h('div', { key: 'remotePort', className: 'dp-field dp-field--port' }, [
              h('label', { key: 'label', className: 'dp-field-label' }, '远程端口'),
              h('input', {
                key: 'input',
                className: 'dp-input dp-mono',
                value: remotePort,
                inputMode: 'numeric',
                placeholder: '8000',
                onChange: (event) => setRemotePort(event.target.value.replace(/[^\d]/gu, '')),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') startTunnel();
                },
              }),
            ]),
            h('div', { key: 'localPort', className: 'dp-field dp-field--port' }, [
              h('label', { key: 'label', className: 'dp-field-label' }, '本地端口'),
              h('input', {
                key: 'input',
                className: 'dp-input dp-mono',
                value: localPort,
                inputMode: 'numeric',
                placeholder: remotePort || '同远程',
                title: '本地端口（留空则与远程端口相同，被占用会自动换一个）',
                onChange: (event) => setLocalPort(event.target.value.replace(/[^\d]/gu, '')),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') startTunnel();
                },
              }),
            ]),
            h('button', {
              key: 'go',
              type: 'button',
              className: 'dp-tool dp-tool--primary',
              disabled: busy || !host || !remotePort,
              onClick: startTunnel,
            }, busy
              ? [h('span', { key: 'spin', className: 'dp-spin-wrap dp-spinning' }, h(Icon, { name: 'refresh', size: 14 })), h('span', { key: 't' }, '转发中…')]
              : '开始转发'),
          ]),
          presetsSupported
            ? h('div', { key: 'restore', className: 'dp-form-row' }, [
                h('label', {
                  key: 'check',
                  className: 'dp-check',
                  style: { flex: '0 0 auto' },
                  title: '勾选后把这次转发保存成预设，机器重连后自动打开',
                }, [
                  h('input', {
                    key: 'cb',
                    type: 'checkbox',
                    checked: autoRestore,
                    onChange: (event) => setAutoRestore(event.target.checked),
                  }),
                  h('span', { key: 't' }, '自动恢复'),
                ]),
                h('input', {
                  key: 'label',
                  className: 'dp-input dp-mono',
                  style: { flex: '1 1 120px' },
                  value: presetLabel,
                  maxLength: 80,
                  placeholder: '备注（可选，重连后自动打开）',
                  onChange: (event) => setPresetLabel(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') startTunnel();
                  },
                }),
              ])
            : null,
          h('div', { key: 'hint', className: 'dp-form-hint' },
            `将 ${host || '远程机器'} 上的 ${remoteHost || '127.0.0.1'}:${remotePort || '端口'} 映射到本地 ${localPort || remotePort || '同号端口'}（留空默认同号，被占用会自动换一个）；成功后点行尾 ↗ 打开。`),
        ]),
        discoverySupported && discoveredVisible.length > 0
          ? h('div', { key: 'discover', className: 'dp-discover' }, [
              h('span', { key: 'label', className: 'dp-discover-label' }, `发现新端口 · ${host}`),
              ...discoveredVisible.map((item) => h('span', {
                key: `port-${item.port}`,
                className: 'dp-port-chip',
                title: `${item.address ?? ''}:${item.port}${item.process ? ` · ${item.process}` : ''}${item.pid ? ` · pid ${item.pid}` : ''}`,
              }, [
                h('span', { key: 'num', className: 'dp-port-num' }, `:${item.port}`),
                item.process ? h('span', { key: 'proc', className: 'dp-port-proc' }, item.process) : null,
                h('button', {
                  key: 'forward',
                  type: 'button',
                  className: 'dp-port-btn',
                  disabled: portBusy === Number(item.port),
                  title: '转发到本地',
                  onClick: () => forwardDiscovered(item),
                }, portBusy === Number(item.port) ? '…' : '转发'),
                h('button', {
                  key: 'dismiss',
                  type: 'button',
                  className: 'dp-port-dismiss',
                  title: '忽略这个端口',
                  onClick: () => dismissPort(item.port),
                }, h(Icon, { name: 'x', size: 11 })),
              ])),
            ])
          : null,
        presetsSupported && presets.length > 0
          ? h('div', { key: 'presets', className: 'dp-presets' }, [
              h('div', { key: 'head', className: 'dp-group-head', style: { padding: '2px 2px 4px' } }, [
                h('span', { key: 'title', className: 'dp-group-name' }, '保存的转发'),
                h('span', { key: 'count', className: 'dp-group-chip' }, `${presets.length} 个`),
                h('div', { key: 'spacer', style: { flex: 1 } }),
                h('span', { key: 'hint', style: { fontSize: 10.5, color: C.muted } }, '勾选 = 重连后自动恢复'),
              ]),
              ...presets.map((preset) => h('div', {
                key: preset.id ?? `${preset.host}:${preset.remotePort}`,
                className: 'dp-preset-row',
              }, [
                h('span', { key: 'dot', className: isPresetOpen(preset) ? 'dp-dot dp-dot--on' : 'dp-dot' }),
                h('div', { key: 'text', className: 'dp-preset-text' }, [
                  h('span', { key: 'label', className: 'dp-preset-label' },
                    preset.label || `${preset.remoteHost ?? '127.0.0.1'}:${preset.remotePort}`),
                  h('span', { key: 'route', className: 'dp-preset-route' },
                    `${preset.host} · ${preset.remoteHost ?? '127.0.0.1'}:${preset.remotePort} → 127.0.0.1:${preset.localPort ?? preset.remotePort}`),
                ]),
                isPresetOpen(preset)
                  ? h('span', { key: 'open', className: 'dp-preset-open' }, '已打开')
                  : h('button', {
                      key: 'launch',
                      type: 'button',
                      className: 'dp-iconbtn',
                      title: '立即打开这个转发',
                      disabled: busy,
                      onClick: () => openPreset(preset),
                    }, h(Icon, { name: 'play', size: 14 })),
                h('label', {
                  key: 'auto',
                  className: 'dp-check',
                  title: preset.autoRestore ? '重连后自动恢复（点击关闭）' : '重连后自动恢复（点击开启）',
                }, [
                  h('input', {
                    key: 'cb',
                    type: 'checkbox',
                    checked: Boolean(preset.autoRestore),
                    onChange: (event) => updatePreset(preset, { autoRestore: event.target.checked }),
                  }),
                ]),
                h('button', {
                  key: 'del',
                  type: 'button',
                  className: 'dp-iconbtn dp-iconbtn--danger',
                  title: '删除这个预设',
                  onClick: () => deletePreset(preset),
                }, h(Icon, { name: 'trash', size: 14 })),
              ])),
            ])
          : null,
        h('div', { key: 'list', className: 'dp-list' },
          loading
            ? h('div', { className: 'dp-loading' }, h(Spinner, { label: '加载中…' }))
            : groups.length === 0
              ? h('div', { key: 'empty', className: 'dp-empty' }, [
                  h('span', { key: 'icon', className: 'dp-empty-icon' }, h(Icon, { name: 'server', size: 22 })),
                  h('span', { key: 'title' }, '还没有端口转发'),
                  h('span', { key: 'hint', className: 'dp-empty-hint' },
                    '填一个远程端口（如 8000 / 6000 / 3000）再点「开始转发」就能在浏览器里访问。agent 用 presence_forward 打开的转发也会自动出现在这里。'),
                ])
              : groups.map(([alias, items]) => h('div', { key: alias, className: 'dp-group' }, [
                  h('div', { key: 'head', className: 'dp-group-head' }, [
                    h('span', { key: 'dot', className: hostConnected(alias) ? 'dp-dot dp-dot--on' : 'dp-dot' }),
                    h('span', { key: 'name', className: 'dp-group-name' }, alias),
                    h('span', { key: 'count', className: 'dp-group-chip' }, `${items.length} 个`),
                    hostConnected(alias) ? null : h('span', { key: 'off', className: 'dp-group-note' }, '未连接'),
                  ]),
                  ...items.map(tunnelRow),
                ]))),
      ]);
    }

    function PresencePanel() {
      const [mode, setMode] = useState('list');
      const [hosts, setHosts] = useState([]);
      const [workspaces, setWorkspaces] = useState([]);
      const [tunnels, setTunnels] = useState([]);
      const [activeId, setActiveId] = useState(null);
      const [browse, setBrowse] = useState(null);
      const [busy, setBusy] = useState(false);
      const [pendingHost, setPendingHost] = useState(null);
      const [password, setPassword] = useState('');
      const [remember, setRemember] = useState(false);
      const [files, setFiles] = useState(null);
      const [preview, setPreview] = useState(null);
      const [loadingList, setLoadingList] = useState(true);
      const [manualOpen, setManualOpen] = useState(false);
      const [manualText, setManualText] = useState('');
      const [manualAlias, setManualAlias] = useState('');
      const [manualNote, setManualNote] = useState('');
      const [manualWarnings, setManualWarnings] = useState([]);
      const [manualBusy, setManualBusy] = useState(false);
      // C2: desktop-notification preference (localStorage like the other UI
      // settings) and the browser permission we last observed.
      const [desktopNotify, setDesktopNotify] = useState(() => readDesktopNotify());
      const [notifyPermission, setNotifyPermission] = useState(() => notificationPermission());

      const loadList = useCallback(async () => {
        try {
          const [state, listing, forwards] = await Promise.all([
            request('/state'),
            request('/workspaces'),
            request('/tunnels'),
          ]);
          setHosts(state.hosts ?? []);
          setWorkspaces(listing.workspaces ?? []);
          setTunnels(forwards.tunnels ?? []);
          setActiveId(listing.active ?? null);
          notifyError(null);
        } catch (err) {
          notifyError(err.message);
        } finally {
          setLoadingList(false);
        }
      }, []);

      useEffect(() => {
        ensureStyles();
        loadList();
      }, [loadList]);

      // /state carries live connection state, so refresh it while the panel is
      // open (and when the window regains focus) instead of showing a dot that
      // was true at mount time.
      useEffect(() => {
        const timer = setInterval(() => { loadList(); }, 5000);
        const refresh = () => { loadList(); };
        window.addEventListener('focus', refresh);
        return () => {
          clearInterval(timer);
          window.removeEventListener('focus', refresh);
        };
      }, [loadList]);

      const addManualHost = useCallback(async () => {
        const text = manualText.trim();
        if (!text) {
          notifyError('请输入 ssh 命令或 user@host[:port]');
          return;
        }
        setManualBusy(true);
        notifyError(null);
        setManualWarnings([]);
        try {
          const result = await request('/custom-hosts', {
            text,
            alias: manualAlias.trim() || undefined,
            note: manualNote.trim() || undefined,
          });
          setManualWarnings(result.warnings ?? []);
          setManualText('');
          setManualAlias('');
          setManualNote('');
          setManualOpen(false);
          await loadList();
          notifySuccess(`已添加主机 ${result.entry.alias}`);
        } catch (err) {
          notifyError(err.message);
        } finally {
          setManualBusy(false);
        }
      }, [manualText, manualAlias, manualNote, loadList]);

      const stopTunnel = useCallback(async (id) => {
        try {
          await request(`/tunnels?id=${encodeURIComponent(id)}`, undefined, 'DELETE');
          await loadList();
        } catch (err) {
          notifyError(err.message);
        }
      }, [loadList]);

      const deleteManualHost = useCallback(async (alias) => {        if (!window.confirm(`删除手动主机「${alias}」？只会删除 Presence 自己保存的配置，不会动 ~/.ssh/config。`)) return;
        setBusy(true);
        try {
          await request(`/custom-hosts?alias=${encodeURIComponent(alias)}`, {}, 'DELETE');
          await loadList();
          notifySuccess('主机已删除');
        } catch (err) {
          notifyError(err.message);
        } finally {
          setBusy(false);
        }
      }, [loadList]);

      const openBrowser = useCallback(async (host, path) => {
        setBusy(true);
        notifyError(null);
        try {
          const query = new URLSearchParams({ host });
          if (path) query.set('path', path);
          const data = await request(`/browse?${query.toString()}`);
          setBrowse(data);
          setMode('browse');
        } catch (err) {
          notifyError(err.message);
        } finally {
          setBusy(false);
        }
      }, []);

      /** Browse the files of an existing workspace. */
      const openFiles = useCallback(async (host, path) => {
        setBusy(true);
        notifyError(null);
        setPreview(null);
        try {
          const query = new URLSearchParams({ host });
          if (path) query.set('path', path);
          const data = await request(`/browse?${query.toString()}`);
          setFiles(data);
          setMode('files');
        } catch (err) {
          notifyError(err.message);
        } finally {
          setBusy(false);
        }
      }, []);

      const openFile = useCallback(async (host, path) => {
        setBusy(true);
        notifyError(null);
        try {
          const query = new URLSearchParams({ host, path });
          setPreview(await request(`/file?${query.toString()}`));
        } catch (err) {
          notifyError(err.message);
        } finally {
          setBusy(false);
        }
      }, []);

      /** Connect first, so a password host asks before it tries to browse. */
      const pickHost = useCallback(async (host, secret) => {
        setBusy(true);
        notifyError(null);
        try {
          await request('/connect', { host, password: secret ?? '', remember: secret ? remember : false });
          setPendingHost(null);
          setPassword('');
          setRemember(false);
          await openBrowser(host);
        } catch (err) {
          if (/password|authenticat/i.test(err.message)) {
            setPendingHost(host);
            notifyError(err.message);
          } else {
            notifyError(err.message);
          }
        } finally {
          setBusy(false);
        }
      }, [openBrowser, remember]);

      const chooseFolder = useCallback(async () => {
        if (!browse) return;
        setBusy(true);
        notifyError(null);
        try {
          await request('/workspaces', { host: browse.host, path: browse.path });
          await loadList();
          setMode('list');
          setBrowse(null);
        } catch (err) {
          notifyError(err.message);
        } finally {
          setBusy(false);
        }
      }, [browse, loadList]);

      const activate = useCallback(async (id) => {
        setBusy(true);
        try {
          const result = await request('/workspaces', { activate: id });
          setActiveId(result.active ?? null);
        } catch (err) {
          notifyError(err.message);
        } finally {
          setBusy(false);
        }
      }, []);

      const remove = useCallback(async (id) => {
        setBusy(true);
        try {
          const result = await request('/workspaces', { remove: id });
          setWorkspaces(result.workspaces ?? []);
          if (activeId === id) setActiveId(null);
        } catch (err) {
          notifyError(err.message);
        } finally {
          setBusy(false);
        }
      }, [activeId]);

      const toggleDesktopNotify = useCallback(async (next) => {
        setDesktopNotify(next);
        writeDesktopNotify(next);
        if (!next) return;
        let permission = notificationPermission();
        if (permission === 'default') permission = await requestDesktopPermission();
        setNotifyPermission(permission);
        if (permission !== 'granted' && permission !== 'unsupported') {
          notifyWarning({ title: t('toast.notifyDenied'), hint: t('toast.notifyDenied.hint') });
        }
      }, []);

      const header = h('header', { className: 'dp-page-head' }, [
        h('div', { key: 'title-row', className: 'dp-page-title-row' }, [
          h('h2', { key: 'title', className: 'dp-page-title' }, '远程工作区'),
          h('span', {
            key: 'count',
            className: 'dp-chip',
          }, mode === 'browse'
            ? `${browse?.host ?? ''} · ${browse?.entries?.length ?? 0} 个文件夹`
            : mode === 'files'
              ? `${files?.host ?? ''} · ${files?.entries?.length ?? 0} 个条目`
              : `${workspaces.length} 个工作区`),
          h('div', { key: 'spacer', style: { flex: 1 } }),
          mode === 'list'
            ? Button({ label: '新建', onClick: () => { setMode('new'); notifyError(null); }, primary: true })
            : Button({ label: '返回', onClick: () => { setMode('list'); setBrowse(null); setFiles(null); setPreview(null); notifyError(null); } }),
        ]),
        h('p', { key: 'sub', className: 'dp-page-subtitle' },
          '选一台机器和一个远程文件夹，agent 就只在这个文件夹里工作；连接常驻复用，远端不安装任何东西。'),
      ]);

      let body;

      if (mode === 'new') {
        const inputStyle = {
          boxSizing: 'border-box', width: '100%', height: 38,
          font: 'inherit', fontSize: 13, padding: '0 10px',
          borderRadius: 8, border: `1px solid ${C.border}`,
          background: 'var(--dsw-alias-bg-layer-1)', color: C.text,
        };
        const manualForm = manualOpen
          ? h('div', {
              key: 'manual-form',
              style: {
                display: 'flex', flexDirection: 'column', gap: 8,
                padding: '12px 14px', margin: '4px 0 12px',
                border: `1px solid ${C.border}`, borderRadius: 12, background: C.soft,
              },
            }, [
              h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 8 } }, [
                h('span', { key: 'title', style: { fontSize: 13, fontWeight: 600 } }, '手动添加主机'),
                h('span', { key: 'hint', style: { color: C.muted, fontSize: 11.5 } },
                  '只保存在 Presence 自己这里，不会改 ~/.ssh/config'),
              ]),
              h('input', {
                key: 'text',
                autoFocus: true,
                value: manualText,
                placeholder: 'ssh -CAXY user@host   或   user@host:2222',
                onChange: (event) => setManualText(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') addManualHost();
                  if (event.key === 'Escape') setManualOpen(false);
                },
                style: { ...inputStyle, height: 42, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
              }),
              h('div', { key: 'row', style: { display: 'flex', gap: 10 } }, [
                h('div', { key: 'aliasField', style: { flex: '1 1 0', minWidth: 0 } }, [
                  h('div', { key: 'label', style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, '别名（可选，自动生成）'),
                  h('input', {
                    key: 'alias',
                    value: manualAlias,
                    placeholder: '例如 example',
                    onChange: (event) => setManualAlias(event.target.value),
                    style: inputStyle,
                  }),
                ]),
                h('div', { key: 'noteField', style: { flex: '1 1 0', minWidth: 0 } }, [
                  h('div', { key: 'label', style: { fontSize: 11, color: C.muted, marginBottom: 3 } }, '备注（可选）'),
                  h('input', {
                    key: 'note',
                    value: manualNote,
                    placeholder: '例如 公司跳板 / GPU 机',
                    onChange: (event) => setManualNote(event.target.value),
                    style: inputStyle,
                  }),
                ]),
              ]),
              manualWarnings.length > 0
                ? h('div', { key: 'warn', style: { color: C.muted, fontSize: 12, lineHeight: 1.6 } },
                    manualWarnings.map((warning) => h('div', { key: warning }, `· ${warning}`)))
                : null,
              h('div', { key: 'actions', style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } }, [
                Button({ label: '取消', small: true, onClick: () => setManualOpen(false) }),
                Button({ label: manualBusy ? '添加中…' : '添加', small: true, primary: true, disabled: manualBusy || !manualText.trim(), onClick: addManualHost }),
              ]),
            ])
          : null;

        body = h('div', { style: { marginTop: 12, borderTop: `1px solid ${C.border}` } }, [
          h('div', {
            key: 'manual-bar',
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0' },
          }, [
            h('span', { key: 'label', style: { color: C.muted, fontSize: 12 } },
              hosts.length > 0 ? `${hosts.length} 台可用机器` : '还没有可用的机器'),
            h('div', { key: 'spacer', style: { flex: 1 } }),
            manualOpen
              ? null
              : Button({ label: '手动添加主机', small: true, onClick: () => { setManualOpen(true); notifyError(null); setManualWarnings([]); } }),
          ]),
          manualForm,
          hosts.length === 0
            ? h('p', { style: { color: C.muted, fontSize: 13, padding: '4px 0 12px' } },
                '~/.ssh/config 里没有可用的机器。可以手动添加一条 ssh 命令。')
            : hosts.flatMap((host) => {
                const manual = host.source === 'manual';
                const connected = Boolean(host.connected);
                const row = h('div', {
                  key: host.alias,
                  style: {
                    display: 'flex',
                    width: '100%',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 8px',
                    borderBottom: `1px solid ${C.border}`,
                    fontSize: 13,
                  },
                }, [
                  h('span', {
                    key: 'dot',
                    title: connected ? '已连接' : '未连接',
                    style: {
                      width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto',
                      background: connected ? C.ok : C.muted,
                      boxShadow: connected ? `0 0 0 3px color-mix(in srgb, ${C.ok} 22%, transparent)` : 'none',
                    },
                  }),
                  h('button', {
                    key: 'pick',
                    type: 'button',
                    onClick: () => pickHost(host.alias),
                    disabled: busy,
                    style: {
                      display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0,
                      border: 'none', background: 'transparent', color: C.text,
                      font: 'inherit', fontSize: 13, textAlign: 'left', padding: 0,
                      cursor: busy ? 'default' : 'pointer',
                    },
                  }, [
                    h('span', { key: 'alias', style: { fontWeight: 600, minWidth: 110 } }, host.alias),
                    manual
                      ? h('span', {
                          key: 'manual',
                          style: {
                            fontSize: 10.5, lineHeight: '16px', padding: '0 7px', borderRadius: 999,
                            background: 'var(--dsw-alias-bg-module-platform)', color: C.muted, flex: '0 0 auto',
                          },
                        }, '手动')
                      : null,
                    connected
                      ? h('span', { key: 'live', style: { color: C.ok, fontSize: 11, flex: '0 0 auto' } }, '已连接')
                      : null,
                    h('span', {
                      key: 'where',
                      style: { color: C.muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    }, `${host.user ?? '?'}@${host.hostname}:${host.port}`),
                    h('span', { key: 'go', style: { color: C.muted } }, '选择 ›'),
                  ]),
                  manual
                    ? h('button', {
                        key: 'remove',
                        type: 'button',
                        title: '删除手动主机',
                        disabled: busy,
                        onClick: (event) => {
                          event.stopPropagation();
                          deleteManualHost(host.alias);
                        },
                        style: {
                          border: 'none', background: 'transparent', color: C.muted,
                          cursor: busy ? 'default' : 'pointer', display: 'inline-flex', padding: 4,
                        },
                      }, h(Icon, { name: 'trash', size: 14 }))
                    : null,
                ]);
                if (pendingHost !== host.alias) return [row];
                return [
                  row,
                  h('div', {
                    key: `${host.alias}:password`,
                    style: {
                      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                      padding: '10px 12px', background: C.soft, borderBottom: `1px solid ${C.border}`,
                    },
                  }, [
                    h('input', {
                      key: 'pwd',
                      type: 'password',
                      value: password,
                      placeholder: `${host.alias} 的 SSH 密码`,
                      autoFocus: true,
                      onChange: (event) => setPassword(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' && password) pickHost(host.alias, password);
                      },
                      style: {
                        flex: '1 1 200px', minWidth: 160, font: 'inherit', fontSize: 13,
                        padding: '6px 10px', borderRadius: 8, border: `1px solid ${C.border}`,
                        background: 'var(--dsw-alias-bg-layer-1)', color: C.text,
                      },
                    }),
                    h('label', {
                      key: 'remember',
                      style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted },
                    }, [
                      h('input', {
                        key: 'checkbox', type: 'checkbox', checked: remember,
                        onChange: (event) => setRemember(event.target.checked),
                      }),
                      h('span', { key: 'label' }, '记住这台'),
                    ]),
                    Button({ label: '连接', onClick: () => pickHost(host.alias, password), primary: true, disabled: !password || busy }),
                  ]),
                ];
              }),
        ]);
      } else if (mode === 'browse' && browse) {
        const crumbs = browse.crumbs ?? [];
        const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : undefined;
        body = h('div', { style: { marginTop: 12 } }, [
          h(BrowserCard, {
            key: 'browser',
            host: browse.host,
            crumbs,
            entries: browse.entries ?? [],
            dirsOnly: true,
            busy,
            onOpenDir: (path) => openBrowser(browse.host, path),
            onBack: () => (parent ? openBrowser(browse.host, parent) : undefined),
            hint: '点击文件夹进入下一层；选好后点下面的「用这个文件夹」',
          }),
          h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 } }, [
            h('div', { key: 'spacer', style: { flex: 1 } }),
            Button({ label: busy ? '创建中…' : '用这个文件夹', onClick: chooseFolder, primary: true, disabled: busy }),
          ]),
        ]);
      } else if (mode === 'files' && files) {
        const crumbs = files.crumbs ?? [];
        const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : undefined;
        body = h('div', { style: { marginTop: 12 } }, [
          h(BrowserCard, {
            key: 'browser',
            host: files.host,
            crumbs,
            entries: files.entries ?? [],
            busy,
            onOpenDir: (path) => openFiles(files.host, path),
            onOpenFile: (path) => openFile(files.host, path),
            onBack: () => (parent ? openFiles(files.host, parent) : undefined),
            preview,
            hint: '点击文件夹进入 · 点击文件在下方预览',
          }),
        ]);
      } else {
        // Group the remote workspaces by machine: one header per host carrying
        // that machine's connection state, then the folders it owns. The dot is
        // about the MACHINE being connected, not about a "current workspace".
        const byHost = new Map();
        for (const workspace of workspaces) {
          if (!byHost.has(workspace.host)) byHost.set(workspace.host, []);
          byHost.get(workspace.host).push(workspace);
        }
        const hostState = new Map(hosts.map((host) => [host.alias, host]));
        const groups = [...byHost.entries()].sort((a, b) => a[0].localeCompare(b[0]));

        const tunnelSection = h('div', {
          key: 'tunnels',
          className: 'dp-section',
        }, [
          h('div', {
            key: 'head',
            className: 'dp-section-head',
          }, [
            h('span', { key: 'icon', className: 'dp-icon', style: { width: 22, height: 22 } }, h(Icon, { name: 'server', size: 13 })),
            h('span', { key: 'title', className: 'dp-section-title' }, '端口转发'),
            h('span', { key: 'count', className: 'dp-chip' }, `${tunnels.length} 个`),
            h('div', { key: 'spacer', style: { flex: 1 } }),
            h('span', { key: 'hint', className: 'dp-section-hint' }, '在右侧栏「端口转发」里新建 / 停止'),
          ]),
          tunnels.length === 0
            ? h('div', { key: 'empty', className: 'dp-empty', style: { padding: '12px 14px' } },
                '没有正在转发的端口。打开右侧栏的「端口转发」标签，把远程 8080 之类的端口映射到本地。')
            : h('div', { key: 'rows', className: 'dp-ws-list' }, tunnels.map((tunnel) => h('div', {
                key: tunnel.id,
                className: 'dp-ws-row',
                style: { cursor: 'default' },
              }, [
                h('span', { key: 'dot', className: 'dp-state-dot', style: { background: C.ok } }),
                h('span', { key: 'host', style: { fontWeight: 600, fontSize: 12.5, whiteSpace: 'nowrap', flex: '0 0 auto' } }, tunnel.host),
                h('span', {
                  key: 'route',
                  className: 'dp-mono',
                  style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
                }, [tunnel.remoteHost, ':', String(tunnel.remotePort),
                  h('span', { key: 'arrow', className: 'dp-tunnel-arrow' }, ' → '),
                  `127.0.0.1:${tunnel.localPort}`]),
                h('a', {
                  key: 'open',
                  href: tunnel.url,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  className: 'dp-link dp-mono',
                  style: { fontSize: 12, whiteSpace: 'nowrap', flex: '0 0 auto' },
                }, '打开'),
                Button({ label: '停止', small: true, onClick: () => stopTunnel(tunnel.id), disabled: busy, className: 'dp-btn--ghost' }),
              ]))),
        ]);

        // C2: background-job completion notifications. The in-app toast is
        // always on; this toggle only controls the OS/browser notification.
        const notificationSection = h('div', {
          key: 'notifications',
          className: 'dp-section',
        }, [
          h('div', {
            key: 'head',
            className: 'dp-section-head',
          }, [
            h('span', { key: 'icon', className: 'dp-icon', style: { width: 22, height: 22 } }, h(Icon, { name: 'info', size: 13 })),
            h('span', { key: 'title', className: 'dp-section-title' }, '通知'),
          ]),
          h('div', { key: 'desktop', className: 'dp-setting-row' }, [
            h('div', { key: 'text', className: 'dp-setting-text' }, [
              h('span', { key: 'title', className: 'dp-setting-title' }, '桌面通知'),
              h('span', { key: 'hint', className: 'dp-setting-hint' },
                notifyPermission === 'unsupported'
                  ? '当前环境不支持浏览器通知；后台任务结束仍会在页面右下角提示。'
                  : notifyPermission === 'denied'
                    ? '浏览器已拒绝通知权限；可在地址栏的权限设置里重新允许。后台任务结束仍会弹出站内提示。'
                    : '后台任务结束（Promise 退出）时额外弹系统通知；站内提示始终保留。'),
            ]),
            h('label', { key: 'toggle', className: 'dp-check', title: '桌面通知' }, [
              h('input', {
                key: 'cb',
                type: 'checkbox',
                checked: desktopNotify,
                onChange: (event) => toggleDesktopNotify(event.target.checked),
              }),
            ]),
          ]),
        ]);

        body = h('div', { className: 'dp-settings-body' }, [
          workspaces.length === 0
            ? h('div', { key: 'none', className: 'dp-empty' }, [
                h('div', { key: 'a', style: { fontWeight: 500, color: C.text, marginBottom: 4 } }, '还没有远程工作区'),
                h('div', { key: 'b' }, '点右上角「新建」，选一台机器，然后在它的目录树里挑一个项目文件夹。'),
              ])
            : groups.map(([alias, folders]) => {
                const host = hostState.get(alias);
                const connected = Boolean(host?.connected);
                // 0.19.0: a retried-then-recovered connection is "degraded", not
                // "connected": the chip says so and its tooltip carries the last
                // error so a flaky machine is visible before the next failure.
                const degraded = host?.state === 'degraded';
                const stateColor = degraded ? C.warn : connected ? C.ok : C.muted;
                return h('div', { key: alias, className: 'dp-host-group' }, [
                  h('div', { key: 'head', className: 'dp-host-head' }, [
                    h('div', { key: 'line', className: 'dp-host-line' }, [
                      h('span', { key: 'name', className: 'dp-host-alias', title: alias }, alias),
                      host?.source === 'manual'
                        ? h('span', { key: 'manual', className: 'dp-chip' }, '手动')
                        : null,
                      h('div', { key: 'spacer', style: { flex: 1 } }),
                      h('span', {
                        key: 'state',
                        className: 'dp-state-chip',
                        style: { color: stateColor },
                        title: degraded ? host?.lastError ?? '连接曾失败，正在使用重试后的连接' : undefined,
                      }, [
                        h('span', {
                          key: 'dot',
                          className: 'dp-state-dot',
                          style: { background: stateColor },
                        }),
                        degraded ? '⚠ 降级' : connected ? '已连接' : '未连接',
                      ]),
                      degraded
                        ? null
                        : connected
                          ? null
                          : Button({ label: '连接', onClick: () => pickHost(alias), small: true, disabled: busy }),
                    ]),
                    host
                      ? h('div', { key: 'where', className: 'dp-host-meta', title: `${host.user ?? '?'}@${host.hostname}:${host.port}` },
                          `${host.user ?? '?'}@${host.hostname}:${host.port}`)
                      : null,
                  ]),
                  h('div', { key: 'list', className: 'dp-ws-list' },
                    folders.map((workspace) => h('div', { key: workspace.id, className: 'dp-ws-row' }, [
                      h('span', { key: 'icon', className: 'dp-ws-icon' }, h(Icon, { name: 'folder', size: 14 })),
                      h('div', { key: 'text', className: 'dp-ws-text' }, [
                        h('div', { key: 'title', className: 'dp-ws-name', title: workspace.title }, [
                          workspace.title,
                          workspace.id === activeId
                            ? h('span', { key: 'active', className: 'dp-chip dp-chip--accent' }, '当前')
                            : null,
                        ]),
                        h('div', { key: 'path', className: 'dp-ws-path', title: workspace.path }, workspace.path),
                      ]),
                      h('div', { key: 'actions', className: 'dp-ws-actions' }, [
                        Button({ label: '浏览', onClick: () => openFiles(workspace.host, workspace.path), small: true, disabled: busy }),
                        Button({ label: '移除', onClick: () => remove(workspace.id), small: true, disabled: busy, className: 'dp-btn--ghost' }),
                      ]),
                    ])),
                  ),
                ]);
              }),
          tunnelSection,
          notificationSection,
        ]);
      }

      return h('section', {
        className: 'dp-ui dp-settings-page',
        style: { color: C.text, fontSize: 14, padding: '4px 0 24px', maxWidth: 780 },
      }, [
        header,
        loadingList
          ? h('div', {
              key: 'loading',
              style: { display: 'flex', justifyContent: 'center', padding: '44px 0' },
            }, h(Spinner, { label: '正在加载工作区…', size: 18 }))
          : h('div', { key: 'content' }, [busy && mode !== 'list'
              ? h('div', {
                  key: 'busy',
                  style: { display: 'flex', justifyContent: 'center', padding: '12px 0' },
                }, h(Spinner, { label: '加载中…' }))
              : null, body]),
      ]);
    }

    return {
      __test: {
        humanizeError,
        pushNotice,
        t,
        currentLocale,
        noticeStore,
        splitHostPort,
        // 0.18 pieces worth exercising without a browser: the pure helpers come
        // from ./features.js, the viewers are exported so a probe can render them.
        ModalShell,
        ContextMenu,
        PromptDialog,
        DiffModal,
        TailModal,
        // 0.21 wait dock: components for render smoke plus the pure wait helpers
        // (also exported from ./waits-ui.js for scripts/wait-ui-probe.mjs).
        WaitDock,
        WaitDockRow,
        WaitDockDetail,
        waitStateInfo,
        computeEta,
        dockPresentation,
        normalizeWaitsPayload,
        formatElapsed,
        formatDurationShort,
        reduceSamples,
        pillLabelText,
        progressRatio,
      },
      inject: ['slots'],
      apply(ctx) {
        ensureStyles();
        if (ctx.effect) {
          ctx.effect(() => mountToaster(ReactDOM), 'presence.toasts');
          // 0.21: the wait dock is global too (chat included), not panel-scoped.
          ctx.effect(() => mountWaitDock(ReactDOM), 'presence.waitDock');
        } else {
          mountToaster(ReactDOM);
          mountWaitDock(ReactDOM);
        }
        // C2: one global job watcher per plugin instance. It only polls until
        // it learns the host has no `jobs` field, and is disposed with the ctx.
        if (ctx.effect) {
          ctx.effect(() => startJobWatcher(), 'presence.jobs');
        } else {
          startJobWatcher();
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'presence',
          order: 55,
          label: 'Presence',
        }, PresencePanel));

        // Right-sidebar file browser (like an Xftp pane). Optional: it mounts
        // only when the shipped sidebar services are present, and a failure here
        // must never take the settings panel down with it.
        const tabId = 'dsh-presence/files';
        ctx.inject(['sidebarRightTabs'], (scope) => {
          scope.effect(() => {
            try {
              return scope.sidebarRightTabs.register({
                id: tabId,
                kind: 'presence-files',
                multiple: false,
                priority: 'extension',
                title: () => '远程文件',
                guide: [{
                  id: 'open',
                  order: 40,
                  title: () => '远程文件',
                  description: () => '拖拽上传/下载远程文件，双击预览图片与文本',
                }],
              });
            } catch (error) {
              console.error('[presence] sidebar tab registration failed', error);
              return () => {};
            }
          }, 'presence.sidebar.tab');
          scope.effect(() => {
            try {
              return scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
                name: 'sidebar.right.pane.tab',
                key: tabId,
              }, RemoteFilesPanel));
            } catch (error) {
              console.error('[presence] sidebar pane registration failed', error);
              return () => {};
            }
          }, 'presence.sidebar.pane');
        });

        // Right-sidebar port forwards: the live list of remote→local tunnels,
        // shared with the agent's presence_forward tool.
        const portsTabId = 'dsh-presence/ports';
        ctx.inject(['sidebarRightTabs'], (scope) => {
          scope.effect(() => {
            try {
              return scope.sidebarRightTabs.register({
                id: portsTabId,
                kind: 'presence-ports',
                multiple: false,
                priority: 'extension',
                title: () => '端口转发',
                guide: [{
                  id: 'open',
                  order: 41,
                  title: () => '端口转发',
                  description: () => '把远程端口映射到本地，直接打开网页服务',
                }],
              });
            } catch (error) {
              console.error('[presence] ports tab registration failed', error);
              return () => {};
            }
          }, 'presence.sidebar.portsTab');
          scope.effect(() => {
            try {
              return scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
                name: 'sidebar.right.pane.tab',
                key: portsTabId,
              }, TunnelPanel));
            } catch (error) {
              console.error('[presence] ports pane registration failed', error);
              return () => {};
            }
          }, 'presence.sidebar.portsPane');
        });
      },
    };
}
