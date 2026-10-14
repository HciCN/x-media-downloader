/**
 * X-Media-Downloader - Dashboard Controller (SPA)
 * 仿 Plucker XBD 核心任务工作台：任务持久化查看、大屏进度追踪、
 * 细粒度媒体勾选、ZIP 打包、断点并发下载与全局配置
 */

(function () {
  'use strict';

  // 环境嗅探：判断是 Chrome 扩展环境，还是手机端/纯 Web 局域网访问环境
  const isExtensionContext = typeof chrome !== 'undefined' && Boolean(chrome?.runtime?.id);

  // 全局页面状态
  const state = {
    currentView: 'tasks', // 'tasks', 'detail', 'settings'
    viewMode: 'grid', // 'grid', 'tweets'
    tasks: [],
    currentTask: null,
    currentItems: [],
    selectedIds: new Set(),
    activeFilter: 'all', // 'all', 'image', 'video', 'failed'
    settings: {
      concurrency: 4,
      folderTemplate: 'X-Media/{username}',
      filenameTemplate: '{username}_{tweet_id}_{index}',
      skipRetweets: true
    }
  };

  // --- 初始化启动 ---
  function initApp() {
    bindNavigation();
    bindSettingsEvents();
    bindDetailActions();
    bindLightboxEvents();
    bindRemoteHubEvents();

    // 如果处于手机浏览器环境，显示移动端徽标
    if (!isExtensionContext) {
      const mobileBadge = document.getElementById('mobile-mode-badge');
      if (mobileBadge) mobileBadge.style.display = 'inline-block';
    }

    // 检查 URL 是否带 task ID
    const urlParams = new URLSearchParams(window.location.search);
    const taskId = urlParams.get('id');
    const tab = urlParams.get('tab');

    loadSettings();
    bindConsoleEvents();

    if (taskId) {
      loadTaskDetail(taskId);
    } else if (tab === 'tasks') {
      switchView('tasks');
    } else if (tab === 'libraries') {
      switchView('libraries');
    } else if (tab === 'remote') {
      switchView('remote');
    } else if (tab === 'settings') {
      switchView('settings');
    } else {
      switchView('console');
    }

    // 局域网/本机服务模式下，定时同步后台状态与 Cloudflare 隧道上线
    if (!isExtensionContext) {
      setInterval(() => {
        if (state.currentView === 'console') {
          loadServerStats();
        }
      }, 4000);
    }

    // 仅在 Chrome 扩展环境下监听来自后台的实时下载进度
    if (isExtensionContext && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.source === 'XMD_BG' && msg.type === 'DOWNLOAD_PROGRESS') {
          onDownloadProgressUpdate(msg.payload);
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }

  // 安全获取博主 Handle 与文件夹名称（杜绝 unknown 命名）
  function getTaskSafeHandle(t) {
    if (!t) return 'X_User';
    let h = (t.x_screen_name || '').trim();
    if (!h || h.toLowerCase() === 'unknown') {
      h = (t.x_name || '').trim();
    }
    if (!h || h.toLowerCase() === 'unknown') {
      const m = (t.task_name || '').match(/@?([a-zA-Z0-9_\u4e00-\u9fa5]+)\s*(?:的媒体库)?/);
      if (m) h = m[1];
    }
    return (h || 'X_User').replace(/[\\/:*?"<>|]/g, '_');
  }

  // --- 导航与视图切换 ---
  function bindNavigation() {
    const brandBtn = document.getElementById('nav-brand-btn');
    if (brandBtn) {
      brandBtn.onclick = (e) => {
        e.preventDefault();
        switchView('console');
      };
    }

    const navTabs = [
      { id: 'tab-btn-console', view: 'console' },
      { id: 'tab-btn-libraries', view: 'libraries' },
      { id: 'tab-btn-tasks', view: 'tasks' },
      { id: 'tab-btn-detail', view: 'detail' },
      { id: 'tab-btn-remote', view: 'remote' },
      { id: 'tab-btn-settings', view: 'settings' }
    ];

    navTabs.forEach(({ id, view }) => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.onclick = (e) => {
          e.preventDefault();
          switchView(view);
        };
      }
    });

    const btnGotoLibs = document.getElementById('btn-goto-libs');
    if (btnGotoLibs) btnGotoLibs.onclick = () => switchView('libraries');

    const btnViewAllTasks = document.getElementById('btn-view-all-tasks');
    if (btnViewAllTasks) btnViewAllTasks.onclick = () => switchView('tasks');

    const detailBackBtn = document.getElementById('detail-back-btn');
    if (detailBackBtn) detailBackBtn.onclick = () => switchView('tasks');

    // 搜索过滤
    const searchInput = document.getElementById('task-search-input');
    if (searchInput) {
      searchInput.oninput = (e) => {
        const q = e.target.value.trim().toLowerCase();
        renderTaskList(q);
      };
    }
  }

  function switchView(viewName) {
    state.currentView = viewName;

    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-tab-btn').forEach(el => el.classList.remove('active'));

    if (viewName === 'console') {
      const el = document.getElementById('view-console');
      const btn = document.getElementById('tab-btn-console');
      if (el) el.classList.add('active');
      if (btn) btn.classList.add('active');
      loadServerStats();
    } else if (viewName === 'libraries') {
      const el = document.getElementById('view-libraries');
      const btn = document.getElementById('tab-btn-libraries');
      if (el) el.classList.add('active');
      if (btn) btn.classList.add('active');
      loadLibrariesList();
    } else if (viewName === 'tasks') {
      document.getElementById('view-task-list').classList.add('active');
      document.getElementById('tab-btn-tasks').classList.add('active');
      loadTaskList();
    } else if (viewName === 'detail') {
      document.getElementById('view-task-detail').classList.add('active');
      document.getElementById('tab-btn-detail').classList.add('active');
      document.getElementById('tab-btn-detail').style.display = 'inline-flex';
    } else if (viewName === 'remote') {
      document.getElementById('view-remote').classList.add('active');
      document.getElementById('tab-btn-remote').classList.add('active');
    } else if (viewName === 'settings') {
      document.getElementById('view-settings').classList.add('active');
      document.getElementById('tab-btn-settings').classList.add('active');
    }
  }

  // =========================================================================
  // 0. Web 控制总台与媒体库管理逻辑
  // =========================================================================

  // 智能二维码生成中心状态
  const qrState = {
    mode: 'tunnel',       // 'tunnel' | 'lan' | 'custom'
    targetPage: 'mobile', // 'mobile' | 'dashboard'
    tunnelUrl: '',        // 公网隧道基址 (如 https://xxx.trycloudflare.com/)
    tunnelMobileUrl: '',  // 公网手机完整地址
    lanIp: '',            // 局域网 IP
    port: 8899,
    customUrl: '',
    lastGeneratedUrl: ''
  };

  function computeTargetUrl() {
    if (qrState.mode === 'tunnel') {
      if (qrState.tunnelUrl) {
        let base = qrState.tunnelUrl.trim();
        if (!base.endsWith('/')) base += '/';
        return qrState.targetPage === 'mobile' ? `${base}mobile.html` : `${base}dashboard.html`;
      }
      return '';
    } else if (qrState.mode === 'lan') {
      const ip = qrState.lanIp || window.location.hostname || '127.0.0.1';
      const port = qrState.port || window.location.port || 8899;
      const portPart = port ? `:${port}` : '';
      return qrState.targetPage === 'mobile'
        ? `http://${ip}${portPart}/mobile.html`
        : `http://${ip}${portPart}/dashboard.html`;
    } else {
      // custom
      return (qrState.customUrl || '').trim();
    }
  }

  function renderQrCode(forcedUrl) {
    const qrImg = document.getElementById('console-qr-img');
    const inputUrl = document.getElementById('console-qr-target-url');
    const badge = document.getElementById('qr-mode-badge');
    const pageTag = document.getElementById('qr-page-type-tag');
    const openBtn = document.getElementById('btn-qr-open');
    const tabTunnel = document.getElementById('qr-tab-tunnel');
    const tabLan = document.getElementById('qr-tab-lan');
    const tabCustom = document.getElementById('qr-tab-custom');

    // 1. 更新 Tab 状态
    if (tabTunnel) tabTunnel.classList.toggle('active', qrState.mode === 'tunnel');
    if (tabLan) tabLan.classList.toggle('active', qrState.mode === 'lan');
    if (tabCustom) tabCustom.classList.toggle('active', qrState.mode === 'custom');

    // 2. 目标页面标签
    if (pageTag) {
      if (qrState.targetPage === 'mobile') {
        pageTag.textContent = '🎬 抖音沉浸刷片 (/mobile.html)';
      } else {
        pageTag.textContent = '💻 控制总台 (/dashboard.html)';
      }
    }

    // 3. 计算实际 URL
    const targetUrl = forcedUrl !== undefined ? forcedUrl : computeTargetUrl();

    // 4. 更新 Badge 提示
    if (badge) {
      if (qrState.mode === 'tunnel') {
        if (qrState.tunnelUrl) {
          badge.className = 'status-badge badge-done';
          badge.textContent = '🌐 公网隧道 (HTTPS)';
        } else {
          badge.className = 'status-badge badge-running';
          badge.textContent = '⏳ 隧道连接中...';
        }
      } else if (qrState.mode === 'lan') {
        badge.className = 'status-badge badge-done';
        badge.textContent = '📶 局域网 (Wi-Fi)';
      } else {
        badge.className = 'status-badge badge-done';
        badge.textContent = '✏️ 自定义专属链接';
      }
    }

    // 5. 更新输入框 (非用户正在打字时更新)
    if (inputUrl && document.activeElement !== inputUrl) {
      if (qrState.mode === 'tunnel' && !qrState.tunnelUrl) {
        inputUrl.placeholder = 'Cloudflare 全球安全隧道连接中... (若急用可点上方【局域网】)';
        inputUrl.value = '';
      } else {
        inputUrl.value = targetUrl;
      }
    }

    // 6. 确定生成二维码的最终展示 URL
    let displayUrl = targetUrl;
    if (!displayUrl && qrState.mode === 'tunnel') {
      const ip = qrState.lanIp || window.location.hostname || '127.0.0.1';
      const port = qrState.port || window.location.port || 8899;
      displayUrl = `http://${ip}:${port}/mobile.html`;
    }

    // 7. 更新二维码图像与打开链接
    if (displayUrl) {
      if (qrImg && qrState.lastGeneratedUrl !== displayUrl) {
        qrState.lastGeneratedUrl = displayUrl;
        qrImg.src = `/api/qrcode?url=${encodeURIComponent(displayUrl)}&_t=${Date.now()}`;
      }
      if (openBtn) {
        openBtn.href = displayUrl;
      }
    }
  }

  function bindConsoleEvents() {
    // 重新扫描全库按钮 (总控页面)
    const btnConsoleRescan = document.getElementById('btn-console-rescan');
    if (btnConsoleRescan) {
      btnConsoleRescan.onclick = async () => {
        btnConsoleRescan.disabled = true;
        btnConsoleRescan.textContent = '⏳ 正在扫描全库...';
        try {
          await fetch('/api/rescan').then(r => r.json());
          await loadServerStats();
        } catch (e) {
          console.error(e);
        } finally {
          btnConsoleRescan.disabled = false;
          btnConsoleRescan.innerHTML = '<span>🔄 重新扫描全库</span>';
        }
      };
    }

    // 重新扫描全库按钮 (媒体库页面)
    const btnRescanLibsPage = document.getElementById('btn-rescan-libraries-page');
    if (btnRescanLibsPage) {
      btnRescanLibsPage.onclick = async () => {
        btnRescanLibsPage.disabled = true;
        btnRescanLibsPage.textContent = '⏳ 正在扫描...';
        try {
          await fetch('/api/rescan').then(r => r.json());
          await loadLibrariesList();
        } catch (e) {
          console.error(e);
        } finally {
          btnRescanLibsPage.disabled = false;
          btnRescanLibsPage.textContent = '🔄 立即重新扫描全库';
        }
      };
    }

    // 挂载新文件夹按钮
    const btnAddLib = document.getElementById('btn-add-library');
    const inputLib = document.getElementById('input-new-library-path');
    const statusLib = document.getElementById('add-library-status');

    if (btnAddLib && inputLib) {
      btnAddLib.onclick = async () => {
        const pathVal = inputLib.value.trim();
        if (!pathVal) {
          alert('请输入或粘贴电脑本地文件夹的完整路径 (如 D:\\Videos)');
          return;
        }

        btnAddLib.disabled = true;
        btnAddLib.textContent = '挂载中...';
        statusLib.style.display = 'block';
        statusLib.style.color = 'var(--text-muted)';
        statusLib.textContent = '正在检测路径并挂载...';

        try {
          const res = await fetch('/api/libraries/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: pathVal })
          }).then(r => r.json());

          if (res && res.success) {
            statusLib.style.color = 'var(--success)';
            statusLib.textContent = `✅ ${res.message || '挂载成功！已自动更新片库'}`;
            inputLib.value = '';
            await loadLibrariesList();
          } else {
            statusLib.style.color = 'var(--danger)';
            statusLib.textContent = `❌ ${res.message || '挂载失败，请确认文件夹真实存在'}`;
          }
        } catch (e) {
          statusLib.style.color = 'var(--danger)';
          statusLib.textContent = `❌ 网络或服务异常: ${e.message}`;
        } finally {
          btnAddLib.disabled = false;
          btnAddLib.textContent = '挂载此文件夹';
        }
      };
    }

    // 复制链接通用按钮 (.btn-copy-url)
    document.querySelectorAll('.btn-copy-url').forEach(btn => {
      btn.onclick = () => {
        const targetId = btn.getAttribute('data-target');
        const input = document.getElementById(targetId);
        if (input && input.value) {
          navigator.clipboard.writeText(input.value).then(() => {
            const old = btn.textContent;
            btn.textContent = '已复制!';
            btn.style.color = 'var(--success)';
            setTimeout(() => {
              btn.textContent = old;
              btn.style.color = '';
            }, 2000);
          });
        }
      };
    });

    // --- 智能二维码生成中枢交互事件绑定 ---
    const tabTunnel = document.getElementById('qr-tab-tunnel');
    const tabLan = document.getElementById('qr-tab-lan');
    const tabCustom = document.getElementById('qr-tab-custom');
    const inputQrTarget = document.getElementById('console-qr-target-url');
    const btnSwitchPage = document.getElementById('btn-qr-switch-page');
    const btnQrRefresh = document.getElementById('btn-qr-refresh');
    const btnQrCopy = document.getElementById('btn-qr-copy');
    const btnQrOpen = document.getElementById('btn-qr-open');
    const btnQrDownload = document.getElementById('btn-qr-download');

    // 1. 切换至公网隧道
    if (tabTunnel) {
      tabTunnel.onclick = () => {
        qrState.mode = 'tunnel';
        renderQrCode();
      };
    }

    // 2. 切换至局域网
    if (tabLan) {
      tabLan.onclick = () => {
        qrState.mode = 'lan';
        renderQrCode();
      };
    }

    // 3. 切换至自定义模式
    if (tabCustom) {
      tabCustom.onclick = () => {
        qrState.mode = 'custom';
        if (inputQrTarget && !qrState.customUrl) {
          qrState.customUrl = inputQrTarget.value.trim() || computeTargetUrl();
        }
        renderQrCode();
        if (inputQrTarget) {
          inputQrTarget.focus();
          inputQrTarget.select();
        }
      };
    }

    // 4. 输入框实时联动 (防抖生成)
    if (inputQrTarget) {
      let qrInputTimer = null;
      inputQrTarget.addEventListener('input', () => {
        qrState.mode = 'custom';
        qrState.customUrl = inputQrTarget.value.trim();
        if (tabTunnel) tabTunnel.classList.remove('active');
        if (tabLan) tabLan.classList.remove('active');
        if (tabCustom) tabCustom.classList.add('active');
        const badge = document.getElementById('qr-mode-badge');
        if (badge) {
          badge.className = 'status-badge badge-done';
          badge.textContent = '✏️ 自定义专属链接';
        }
        clearTimeout(qrInputTimer);
        qrInputTimer = setTimeout(() => {
          renderQrCode();
        }, 350);
      });

      inputQrTarget.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          qrState.mode = 'custom';
          qrState.customUrl = inputQrTarget.value.trim();
          renderQrCode();
          inputQrTarget.blur();
        }
      });
    }

    // 5. 切换目标页面 (手机刷片 / 控制台)
    if (btnSwitchPage) {
      btnSwitchPage.onclick = () => {
        qrState.targetPage = (qrState.targetPage === 'mobile') ? 'dashboard' : 'mobile';
        if (qrState.mode === 'custom') {
          let url = (inputQrTarget?.value || qrState.customUrl || '').trim();
          if (url.includes('mobile.html')) {
            url = url.replace('mobile.html', 'dashboard.html');
          } else if (url.includes('dashboard.html')) {
            url = url.replace('dashboard.html', 'mobile.html');
          } else if (url.endsWith('/')) {
            url = url + (qrState.targetPage === 'mobile' ? 'mobile.html' : 'dashboard.html');
          } else if (url) {
            try {
              const u = new URL(url);
              u.pathname = (qrState.targetPage === 'mobile' ? '/mobile.html' : '/dashboard.html');
              url = u.toString();
            } catch (_) {}
          }
          qrState.customUrl = url;
          if (inputQrTarget) inputQrTarget.value = url;
        }
        renderQrCode();
      };
    }

    // 6. 立即刷新生成二维码
    if (btnQrRefresh) {
      btnQrRefresh.onclick = () => {
        if (inputQrTarget && inputQrTarget.value.trim()) {
          qrState.customUrl = inputQrTarget.value.trim();
        }
        renderQrCode();
        const origText = btnQrRefresh.innerHTML;
        btnQrRefresh.innerHTML = '<span>✓ 已更新</span>';
        setTimeout(() => {
          btnQrRefresh.innerHTML = origText;
        }, 1200);
      };
    }

    // 7. 复制二维码目标链接
    if (btnQrCopy) {
      btnQrCopy.onclick = () => {
        const urlToCopy = (inputQrTarget?.value || qrState.lastGeneratedUrl || '').trim();
        if (urlToCopy) {
          const successCallback = () => {
            const orig = btnQrCopy.innerHTML;
            btnQrCopy.innerHTML = '<span style="color:var(--success); font-weight:700;">✓ 已复制!</span>';
            setTimeout(() => {
              btnQrCopy.innerHTML = orig;
            }, 2000);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(urlToCopy).then(successCallback).catch(() => {
              if (inputQrTarget) {
                inputQrTarget.select();
                document.execCommand('copy');
                successCallback();
              }
            });
          } else if (inputQrTarget) {
            inputQrTarget.select();
            document.execCommand('copy');
            successCallback();
          }
        }
      };
    }

    // 8. 打开链接检查
    if (btnQrOpen) {
      btnQrOpen.onclick = (e) => {
        const target = (inputQrTarget?.value || qrState.lastGeneratedUrl || '').trim();
        if (!target) {
          e.preventDefault();
          alert('暂无可打开的有效链接，请先生成或输入目标地址');
          return;
        }
        btnQrOpen.href = target;
      };
    }

    // 9. 保存/下载二维码图片
    if (btnQrDownload) {
      btnQrDownload.onclick = async (e) => {
        e.preventDefault();
        const qrImg = document.getElementById('console-qr-img');
        if (!qrImg || !qrImg.src) return;
        const orig = btnQrDownload.innerHTML;
        btnQrDownload.innerHTML = '<span>⏳ 保存中...</span>';
        try {
          const resp = await fetch(qrImg.src);
          const blob = await resp.blob();
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = `xmedia_qrcode_${qrState.mode}_${qrState.targetPage}_${Date.now()}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        } catch (err) {
          window.open(qrImg.src, '_blank');
        } finally {
          setTimeout(() => {
            btnQrDownload.innerHTML = orig;
          }, 800);
        }
      };
    }
  }

  async function loadServerStats() {
    try {
      const res = await fetch('/api/server_stats').then(r => r.json());
      if (res && res.success) {
        document.getElementById('console-task-count').textContent = res.task_count || 0;
        document.getElementById('console-video-count').textContent = res.video_count || 0;
        document.getElementById('console-image-count').textContent = res.image_count || 0;
        document.getElementById('console-lib-count').textContent = res.library_count || 0;

        // 本机控制台地址
        const localInput = document.getElementById('console-local-url');
        const localOpen = document.getElementById('console-local-open');
        const localUrl = res.localhost_url || (window.location.origin + '/dashboard.html');
        if (localInput) localInput.value = localUrl;
        if (localOpen) localOpen.href = localUrl;

        // 局域网地址
        const lanInput = document.getElementById('console-lan-url');
        const lanOpen = document.getElementById('console-lan-open');
        if (lanInput) lanInput.value = res.mobile_url || '';
        if (lanOpen) lanOpen.href = res.mobile_url || '#';

        // 局域网移动端中心同步 IP
        const remoteIpInput = document.getElementById('remote-ip-input');
        if (remoteIpInput && !remoteIpInput.value && res.lan_ip) {
          remoteIpInput.value = res.lan_ip;
        }

        // 公网隧道
        const tunnelRow = document.getElementById('console-tunnel-row');
        const tunnelInput = document.getElementById('console-tunnel-url');
        const tunnelOpen = document.getElementById('console-tunnel-open');
        if (res.tunnel_mobile_url) {
          if (tunnelRow) tunnelRow.style.display = 'flex';
          if (tunnelInput) tunnelInput.value = res.tunnel_mobile_url;
          if (tunnelOpen) tunnelOpen.href = res.tunnel_mobile_url;
        } else {
          if (tunnelRow) tunnelRow.style.display = 'none';
        }

        // 智能二维码参数更新
        qrState.lanIp = res.lan_ip || qrState.lanIp;
        qrState.port = res.port || qrState.port;
        if (res.tunnel_url) {
          qrState.tunnelUrl = res.tunnel_url;
        }
        if (res.tunnel_mobile_url) {
          qrState.tunnelMobileUrl = res.tunnel_mobile_url;
        }

        // 渲染智能二维码 (若处于自定义模式且用户已输入自定义链接则不强制覆盖输入内容)
        if (qrState.mode !== 'custom' || !qrState.customUrl) {
          renderQrCode();
        }

        // 加载近期博主列表
        renderConsoleRecentTasks();
      }
    } catch (e) {
      console.warn('获取服务器状态失败:', e);
    }
  }

  async function renderConsoleRecentTasks() {
    const container = document.getElementById('console-recent-grid');
    if (!container) return;

    try {
      const res = await fetch('/api/tasks').then(r => r.json());
      if (res && res.success && res.tasks) {
        state.tasks = res.tasks;
        container.innerHTML = '';
        const recent = res.tasks.slice(0, 6);
        if (recent.length === 0) {
          container.innerHTML = '<div style="color:var(--text-muted); font-size:13px; grid-column:1/-1;">暂未扫描到媒体合集，请在媒体库管理中挂载本地文件夹。</div>';
          return;
        }

        for (const task of recent) {
          const card = document.createElement('div');
          card.className = 'task-card';
          card.onclick = () => {
            loadTaskDetail(task.id);
            switchView('detail');
          };

          const handle = task.x_screen_name || 'X_User';
          const name = task.x_name || task.task_name || handle;
          const initial = escapeHtml((name[0] || 'X').toUpperCase());
          const avatarHtml = task.x_avatar
            ? `<img class="task-card-avatar" src="${task.x_avatar}" onerror="this.outerHTML='<div class=\\'task-card-avatar avatar-placeholder\\'>${initial}</div>'" />`
            : `<div class="task-card-avatar avatar-placeholder">${initial}</div>`;

          card.innerHTML = `
            <div class="task-card-header">
              ${avatarHtml}
              <div class="task-card-info">
                <div class="task-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                <div class="task-card-handle">@${escapeHtml(handle)}</div>
              </div>
              <span class="status-badge badge-done">${task.media_count || 0} 媒体</span>
            </div>
            <div style="font-size:12px; color:var(--text-muted); margin-top:8px; display:flex; justify-content:space-between;">
              <span>本地已归档</span>
              <span style="color:var(--accent);">点击在线看 →</span>
            </div>
          `;
          container.appendChild(card);
        }
      }
    } catch (e) {}
  }

  async function loadLibrariesList() {
    const container = document.getElementById('libraries-container');
    const badge = document.getElementById('library-count-badge');
    if (!container) return;

    container.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">正在加载媒体库列表...</div>';

    try {
      const res = await fetch('/api/libraries').then(r => r.json());
      if (res && res.success && res.libraries) {
        const libs = res.libraries;
        if (badge) badge.textContent = libs.length;
        container.innerHTML = '';

        if (libs.length === 0) {
          container.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">暂未挂载任何文件夹。</div>';
          return;
        }

        libs.forEach((item) => {
          const row = document.createElement('div');
          row.className = 'library-row-card';

          const statusBadge = item.exists
            ? `<span class="status-badge badge-done">🟢 正常已连接</span>`
            : `<span class="status-badge" style="background:rgba(249,24,128,0.2); color:var(--danger);">⚠️ 路径不存在</span>`;

          const typeTag = item.is_default
            ? `<span style="font-size:11px; background:rgba(29,155,240,0.15); color:var(--accent); padding:2px 8px; border-radius:10px; font-weight:700;">系统默认下载库</span>`
            : `<span style="font-size:11px; background:rgba(168,85,247,0.15); color:#a855f7; padding:2px 8px; border-radius:10px; font-weight:700;">自定义挂载库</span>`;

          row.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:6px; flex:1; min-width:0;">
              <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:16px;">📁</span>
                <span class="library-path-text">${escapeHtml(item.path)}</span>
              </div>
              <div style="display:flex; align-items:center; gap:8px;">
                ${statusBadge}
                ${typeTag}
              </div>
            </div>
            <div>
              ${item.is_default ? '' : `
                <button class="btn btn-danger btn-remove-lib" style="padding:6px 12px; font-size:12px;">
                  🗑️ 移除
                </button>
              `}
            </div>
          `;

          const removeBtn = row.querySelector('.btn-remove-lib');
          if (removeBtn) {
            removeBtn.onclick = async () => {
              if (confirm(`确定要从片库中移除目录：\n${item.path}\n(仅移除挂载映射，不会删除您硬盘里的任何真实文件)？`)) {
                removeBtn.disabled = true;
                removeBtn.textContent = '移除中...';
                try {
                  await fetch('/api/libraries/remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: item.path })
                  });
                  await loadLibrariesList();
                } catch (e) {
                  alert('移除失败: ' + e.message);
                }
              }
            };
          }

          container.appendChild(row);
        });
      }
    } catch (e) {
      container.innerHTML = `<div style="color:var(--danger); font-size:13px;">加载媒体库失败: ${e.message}</div>`;
    }
  }

  // =========================================================================
  // 1. 任务列表视图逻辑
  // =========================================================================
  async function loadTaskList() {
    if (isExtensionContext) {
      chrome.runtime.sendMessage({ type: 'GET_TASK_LIST' }, (res) => {
        if (res && res.success) {
          state.tasks = res.tasks || [];
          renderTaskList();
          // 静默同步任务至 Python 远程服务
          syncAllTasksToRemote();
        }
      });
    } else {
      // 手机端/外部浏览器访问：直接走本地远程 HTTP API
      try {
        const res = await fetch('/api/tasks').then(r => r.json());
        if (res && res.success) {
          state.tasks = res.tasks || [];
          renderTaskList();
        }
      } catch (err) {
        console.warn('获取远程任务列表失败:', err);
      }
    }
  }

  function renderTaskList(searchQuery = '') {
    const container = document.getElementById('task-cards-container');
    const emptyEl = document.getElementById('task-list-empty');
    container.innerHTML = '';

    let filtered = state.tasks;
    if (searchQuery) {
      filtered = filtered.filter(t =>
        (t.x_name || '').toLowerCase().includes(searchQuery) ||
        (t.x_screen_name || '').toLowerCase().includes(searchQuery) ||
        (t.task_name || '').toLowerCase().includes(searchQuery)
      );
    }

    if (filtered.length === 0) {
      emptyEl.style.display = 'block';
      if (!isExtensionContext) {
        emptyEl.innerHTML = `
          <div style="font-size:16px; font-weight:700; color:var(--text-main); margin-bottom:8px;">📱 手机端尚未同步到博主任务</div>
          <div style="font-size:13px; color:var(--text-muted); line-height:1.7; max-width:480px; margin:0 auto;">
            请在电脑端 Chrome 中点击扩展图标打开 <strong>X-Media-Downloader 控制台</strong>，切换到 <strong>「📱 安卓远程观看」</strong> 页面，点击 <strong>「🔄 一键推送数据至手机服务」</strong>，所有已抓取的博主推文与媒体将瞬间全量同步到手机端！
          </div>
        `;
      } else {
        emptyEl.textContent = '暂无本地抓取任务。在 X.com 浏览任意博主并点击悬浮窗抓取，数据将自动归档至此处！';
      }
      return;
    }
    emptyEl.style.display = 'none';

    filtered.forEach(t => {
      const card = document.createElement('div');
      card.className = 'task-card';

      const pct = t.media_count > 0 ? Math.round((t.completed_count / t.media_count) * 100) : 0;
      const statusBadgeClass = {
        running: 'badge-running',
        completed: 'badge-done',
        pending: 'badge-queued',
        failed: 'badge-error'
      }[t.status] || 'badge-queued';

      card.innerHTML = `
        <div class="task-card-top">
          <div class="task-card-user">
            <img class="task-card-avatar" src="${t.x_avatar || ''}" />
            <div>
              <div class="task-card-name">${t.x_name || t.task_name || '未命名任务'}</div>
              <div class="task-card-handle">@${getTaskSafeHandle(t)}</div>
            </div>
          </div>
          <span class="status-badge ${statusBadgeClass}">${t.status}</span>
        </div>

        <div class="task-card-progress">
          <div class="task-card-progress-fill" style="width:${pct}%"></div>
        </div>

        <div class="task-card-stats">
          <span>完成度: ${t.completed_count} / ${t.media_count} (${pct}%)</span>
          <span>${new Date(t.created_at).toLocaleDateString()}</span>
        </div>
      `;

      const avatarEl = card.querySelector('.task-card-avatar');
      if (avatarEl) {
        if (!t.x_avatar) {
          avatarEl.style.display = 'none';
        } else {
          avatarEl.addEventListener('error', () => {
            avatarEl.style.display = 'none';
          });
        }
      }

      card.onclick = () => {
        loadTaskDetail(t.id);
      };

      container.appendChild(card);
    });
  }

  // =========================================================================
  // 2. 任务详情与下载大屏逻辑
  // =========================================================================
  async function loadTaskDetail(taskId) {
    if (isExtensionContext) {
      chrome.runtime.sendMessage({ type: 'GET_TASK_DETAIL', payload: { taskId } }, (res) => {
        if (res && res.success) {
          state.currentTask = res.task;
          state.currentItems = res.items || [];
          state.selectedIds.clear();
          // 默认全选
          state.currentItems.forEach(it => state.selectedIds.add(it.id));

          renderDetailDashboard();
          switchView('detail');

          // 静默同步当前任务和媒体至 Python 远程服务
          syncSingleTaskToRemote(res.task, res.items);
        } else {
          alert('加载任务详情失败: ' + (res?.error || '未知错误'));
        }
      });
    } else {
      // 手机端/外部浏览器访问：通过 HTTP API 获取单任务详情
      try {
        const res = await fetch(`/api/task_detail?id=${encodeURIComponent(taskId || '')}`).then(r => r.json());
        if (res && res.success && res.task) {
          state.currentTask = res.task;
          state.currentItems = res.items || [];
          state.selectedIds.clear();
          state.currentItems.forEach(it => state.selectedIds.add(it.id));

          renderDetailDashboard();
          switchView('detail');
        } else {
          alert('远程服务中暂无此任务数据，请在电脑端打开该任务以自动完成同步。');
        }
      } catch (err) {
        console.warn('加载远程任务详情失败:', err);
      }
    }
  }

  function renderDetailDashboard() {
    const t = state.currentTask;
    if (!t) return;

    // 博主信息
    document.getElementById('detail-name').textContent = t.x_name || t.task_name || '未命名博主';
    document.getElementById('detail-handle').textContent = `@${getTaskSafeHandle(t)}`;
    document.getElementById('detail-bio').textContent = t.x_description || '';
    const avatarEl = document.getElementById('detail-avatar');
    if (t.x_avatar) {
      avatarEl.src = t.x_avatar;
      avatarEl.style.display = 'block';
    } else {
      avatarEl.style.display = 'none';
    }

    // 状态徽标
    const badgeEl = document.getElementById('detail-status-badge');
    badgeEl.textContent = t.status;
    badgeEl.className = 'status-badge ' + (
      t.status === 'running' ? 'badge-running' :
      t.status === 'completed' ? 'badge-done' :
      t.status === 'failed' ? 'badge-error' : 'badge-queued'
    );

    // 计算统计指标
    let completed = 0, failed = 0, pending = 0, imgCount = 0, vidCount = 0;
    for (const item of state.currentItems) {
      if (item.download_status === 'completed') completed++;
      else if (item.download_status === 'failed') failed++;
      else pending++;

      if (item.mediaType === 'video') vidCount++;
      else imgCount++;
    }

    const total = state.currentItems.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    // 四格指标看板
    document.getElementById('board-total').textContent = total;
    document.getElementById('board-completed').textContent = completed;
    document.getElementById('board-pending').textContent = pending;
    document.getElementById('board-failed').textContent = failed;

    // 进度条
    document.getElementById('detail-progress-summary').textContent = `已下载完成: ${completed} / ${total}`;
    document.getElementById('detail-progress-pct').textContent = `${pct}%`;
    const fillEl = document.getElementById('detail-progress-fill');
    fillEl.style.width = `${pct}%`;
    if (t.status === 'running') fillEl.classList.add('running');
    else fillEl.classList.remove('running');

    // 筛选标签数量
    document.getElementById('count-all').textContent = total;
    document.getElementById('count-images').textContent = imgCount;
    document.getElementById('count-videos').textContent = vidCount;
    document.getElementById('count-failed').textContent = failed;

    updateSelectedCountUI();
    renderActiveView();
  }

  function updateSelectedCountUI() {
    document.getElementById('selected-items-count').textContent = state.selectedIds.size;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getFilteredItems() {
    let filtered = state.currentItems;
    if (state.activeFilter === 'image') filtered = filtered.filter(it => it.mediaType === 'image');
    else if (state.activeFilter === 'video') filtered = filtered.filter(it => it.mediaType === 'video');
    else if (state.activeFilter === 'failed') filtered = filtered.filter(it => it.download_status === 'failed');
    return filtered;
  }

  function renderActiveView() {
    const grid = document.getElementById('media-waterfall-grid');
    const tweetsCont = document.getElementById('tweets-waterfall-container');
    if (!grid || !tweetsCont) return;

    if (state.viewMode === 'tweets') {
      grid.style.display = 'none';
      tweetsCont.style.display = 'flex';
      renderTweetsWaterfall();
    } else {
      tweetsCont.style.display = 'none';
      grid.style.display = 'grid';
      renderMediaWaterfall();
    }
  }

  function createMediaCardElement(it, list, index) {
    const itemEl = document.createElement('div');
    itemEl.className = 'gallery-item' + (state.selectedIds.has(it.id) ? ' selected' : '');
    itemEl.setAttribute('data-id', it.id);

    const isVideo = it.mediaType === 'video';
    const isChecked = state.selectedIds.has(it.id);
    const dotClass = it.download_status === 'completed' ? 'dot-completed' :
                     it.download_status === 'failed' ? 'dot-failed' : 'dot-pending';
    const tweetUrl = it.tweetId ? `https://x.com/i/status/${it.tweetId}` : '';
    const textPreview = escapeHtml(it.tweetText || '');
    const textDisplay = it.tweetText ? (it.tweetText.slice(0, 36) + (it.tweetText.length > 36 ? '...' : '')) : '查看原推文';

    let mediaHtml = '';
    if (isVideo) {
      if (it.thumbUrl && !it.thumbUrl.toLowerCase().endsWith('.mp4')) {
        mediaHtml = `
          <img class="gallery-thumb-img" src="${it.thumbUrl}" loading="lazy" onerror="this.outerHTML='<video class=\\'gallery-thumb-img gallery-thumb-video\\' src=\\'${it.mediaUrl}#t=0.001\\' preload=\\'metadata\\' muted playsinline controlsList=\\'nodownload\\'></video>'" />
          <div class="gallery-video-play-hint">▶</div>
        `;
      } else {
        mediaHtml = `
          <video class="gallery-thumb-img gallery-thumb-video" src="${it.mediaUrl}#t=0.001" preload="metadata" muted playsinline controlsList="nodownload"></video>
          <div class="gallery-video-play-hint">▶</div>
        `;
      }
    } else {
      mediaHtml = `<img class="gallery-thumb-img" src="${it.thumbUrl || it.mediaUrl}" loading="lazy" onerror="this.onerror=null;this.src='/api/avatar_svg?name=IMG'" />`;
    }

    itemEl.innerHTML = `
      <input type="checkbox" class="gallery-checkbox" ${isChecked ? 'checked' : ''} />
      <span class="gallery-status-dot ${dotClass}" title="状态: ${it.download_status || 'pending'}"></span>
      ${mediaHtml}
      <span class="gallery-badge">${isVideo ? 'MP4' : 'IMG'}</span>
      <div class="gallery-item-overlay">
        <div class="gallery-item-text" title="${textPreview}">${escapeHtml(textDisplay)}</div>
        <div class="gallery-item-footer">
          ${tweetUrl ? `<a href="${tweetUrl}" target="_blank" class="gallery-tweet-link" title="在 X 查看原推文">查看原推 ↗</a>` : ''}
        </div>
      </div>
    `;

    // 勾选事件
    const cb = itemEl.querySelector('.gallery-checkbox');
    cb.onclick = (e) => {
      e.stopPropagation();
      if (cb.checked) {
        state.selectedIds.add(it.id);
        itemEl.classList.add('selected');
      } else {
        state.selectedIds.delete(it.id);
        itemEl.classList.remove('selected');
      }
      updateSelectedCountUI();
    };

    // 阻止原推链接冒泡触发 Lightbox
    const tweetLink = itemEl.querySelector('.gallery-tweet-link');
    if (tweetLink) {
      tweetLink.onclick = (e) => {
        e.stopPropagation();
      };
    }

    // 视频卡片鼠标悬浮预览 (自动播放静音小视频，离开暂停复位)
    if (isVideo) {
      const vid = itemEl.querySelector('video');
      if (vid) {
        itemEl.addEventListener('mouseenter', () => {
          try {
            vid.currentTime = 0;
            const p = vid.play();
            if (p) p.catch(() => {});
          } catch (_) {}
        });
        itemEl.addEventListener('mouseleave', () => {
          try {
            vid.pause();
            vid.currentTime = 0.001;
          } catch (_) {}
        });
      }
    }

    // 点击打开相册级全屏 Lightbox 播放/查看
    itemEl.onclick = () => {
      if (isVideo) {
        const vid = itemEl.querySelector('video');
        if (vid) {
          try { vid.pause(); } catch (_) {}
        }
      }
      if (list && typeof index === 'number') {
        openLightbox(list, index);
      } else {
        openLightbox(it);
      }
    };

    return itemEl;
  }

  // 渲染媒体瀑布流画廊
  function renderMediaWaterfall() {
    const grid = document.getElementById('media-waterfall-grid');
    grid.innerHTML = '';

    const filtered = getFilteredItems();
    if (filtered.length === 0) {
      grid.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">当前筛选条件下暂无媒体</div>';
      return;
    }

    filtered.forEach((it, idx) => {
      grid.appendChild(createMediaCardElement(it, filtered, idx));
    });
  }

  // 渲染推文分组卡片流
  function renderTweetsWaterfall() {
    const container = document.getElementById('tweets-waterfall-container');
    container.innerHTML = '';

    const filtered = getFilteredItems();
    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state">当前筛选条件下暂无推文媒体</div>';
      return;
    }

    // 按 tweetId 分组
    const groups = new Map();
    for (const item of filtered) {
      const key = item.tweetId || 'unknown';
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(item);
    }

    groups.forEach((items, tweetId) => {
      const first = items[0] || {};
      const card = document.createElement('div');
      card.className = 'dashboard-tweet-card';

      let dateStr = '';
      if (first.createdAt) {
        try {
          const d = new Date(first.createdAt);
          dateStr = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        } catch (e) {}
      }

      const tweetUrl = tweetId && tweetId !== 'unknown' ? `https://x.com/i/status/${tweetId}` : '';

      card.innerHTML = `
        <div class="dashboard-tweet-header">
          <div class="dashboard-tweet-meta">
            <span style="font-weight:700; color:var(--text-main);">推文 ID: ${tweetId}</span>
            ${dateStr ? `<span>•</span><span>${dateStr}</span>` : ''}
          </div>
          ${tweetUrl ? `
            <a href="${tweetUrl}" target="_blank" class="dashboard-view-tweet-btn" title="在 X/Twitter 查看原推文">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              在 X 查看原推文 ↗
            </a>
          ` : ''}
        </div>
        ${first.tweetText ? `<div class="dashboard-tweet-body">${escapeHtml(first.tweetText)}</div>` : ''}
        <div class="dashboard-tweet-media-grid"></div>
        <div class="dashboard-tweet-footer">
          <span>包含 <strong>${items.length}</strong> 个媒体</span>
          <button class="btn btn-secondary btn-download-group" style="padding:4px 10px; font-size:12px;">下载本推媒体 (${items.length})</button>
        </div>
      `;

      const mediaGrid = card.querySelector('.dashboard-tweet-media-grid');
      items.forEach(it => {
        const fullIdx = filtered.findIndex(x => x.id === it.id);
        mediaGrid.appendChild(createMediaCardElement(it, filtered, fullIdx !== -1 ? fullIdx : 0));
      });

      const groupDlBtn = card.querySelector('.btn-download-group');
      if (groupDlBtn) {
        groupDlBtn.onclick = () => {
          const folderName = `X-Media/${state.currentTask?.x_screen_name || 'unknown'}`;
          chrome.runtime.sendMessage({
            source: 'XMD_CONTENT',
            type: 'START_DOWNLOAD_BATCH',
            payload: {
              items: items,
              folderName,
              concurrency: state.settings.concurrency || 4,
              taskId: state.currentTask?.id
            }
          });
        };
      }

      container.appendChild(card);
    });
  }

  // 绑定控制按钮事件
  function bindDetailActions() {
    // 视图模式切换（平铺画廊 vs 推文卡片流）
    const viewModeSelect = document.getElementById('dashboard-view-mode');
    if (viewModeSelect) {
      viewModeSelect.value = state.viewMode || 'grid';
      viewModeSelect.onchange = (e) => {
        state.viewMode = e.target.value;
        renderActiveView();
      };
    }

    // 筛选标签
    document.querySelectorAll('.gallery-filters .filter-pill').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.gallery-filters .filter-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.activeFilter = btn.getAttribute('data-filter');
        renderActiveView();
      };
    });

    // 全选/全不选/反选
    document.getElementById('btn-select-all').onclick = () => {
      state.currentItems.forEach(it => state.selectedIds.add(it.id));
      updateSelectedCountUI();
      renderActiveView();
    };

    document.getElementById('btn-select-none').onclick = () => {
      state.selectedIds.clear();
      updateSelectedCountUI();
      renderActiveView();
    };

    document.getElementById('btn-select-invert').onclick = () => {
      state.currentItems.forEach(it => {
        if (state.selectedIds.has(it.id)) state.selectedIds.delete(it.id);
        else state.selectedIds.add(it.id);
      });
      updateSelectedCountUI();
      renderActiveView();
    };

    // 开始批量下载 (支持弹窗确认与自由自定义下载保存文件夹)
    document.getElementById('btn-start-download').onclick = () => {
      if (!state.currentTask) return;
      const targetItems = state.currentItems.filter(it => it.download_status !== 'completed');
      if (targetItems.length === 0) {
        alert('当前任务中所有媒体均已下载完成！');
        return;
      }

      const safeHandle = getTaskSafeHandle(state.currentTask);
      const defaultFolder = `X-Media/${safeHandle}`;

      const modal = document.getElementById('modal-batch-download');
      const bloggerEl = document.getElementById('batch-modal-blogger');
      const countEl = document.getElementById('batch-modal-count');
      const folderInput = document.getElementById('batch-modal-folder');
      const concurrencySelect = document.getElementById('batch-modal-concurrency');

      if (bloggerEl) bloggerEl.textContent = `@${safeHandle} (${state.currentTask.x_name || state.currentTask.task_name})`;
      if (countEl) countEl.innerHTML = `本次待下载 <strong>${targetItems.length}</strong> 个媒体 (已完成 ${state.currentTask.completed_count || 0} / 共 ${state.currentItems.length} 项)`;
      if (folderInput) folderInput.value = defaultFolder;
      if (concurrencySelect) concurrencySelect.value = String(state.settings.concurrency || 4);

      if (modal) modal.style.display = 'flex';
    };

    // 绑定批量下载确认弹窗事件
    const batchModal = document.getElementById('modal-batch-download');
    const closeBatchModal = () => {
      if (batchModal) batchModal.style.display = 'none';
    };
    const btnCloseModal = document.getElementById('btn-close-batch-modal');
    if (btnCloseModal) btnCloseModal.onclick = closeBatchModal;
    const btnCancelModal = document.getElementById('btn-cancel-batch-download');
    if (btnCancelModal) btnCancelModal.onclick = closeBatchModal;

    const btnConfirmModal = document.getElementById('btn-confirm-batch-download');
    if (btnConfirmModal) {
      btnConfirmModal.onclick = () => {
        if (!state.currentTask) return;
        const targetItems = state.currentItems.filter(it => it.download_status !== 'completed');
        if (targetItems.length === 0) return closeBatchModal();

        const safeHandle = getTaskSafeHandle(state.currentTask);
        const folderInput = document.getElementById('batch-modal-folder');
        const concurrencySelect = document.getElementById('batch-modal-concurrency');
        const customFolder = (folderInput?.value || '').trim() || `X-Media/${safeHandle}`;
        const concurrency = parseInt(concurrencySelect?.value || '4') || 4;

        chrome.runtime.sendMessage({
          source: 'XMD_CONTENT',
          type: 'START_DOWNLOAD_BATCH',
          payload: {
            items: targetItems,
            folderName: customFolder,
            concurrency,
            taskId: state.currentTask.id
          }
        }, () => {
          state.currentTask.status = 'running';
          renderDetailDashboard();
        });

        closeBatchModal();
      };
    }

    // 暂停下载
    document.getElementById('btn-pause-download').onclick = () => {
      chrome.runtime.sendMessage({ type: 'PAUSE_DOWNLOAD_BATCH' });
    };

    // 重试失败项
    document.getElementById('btn-retry-failed').onclick = () => {
      const failedItems = state.currentItems.filter(it => it.download_status === 'failed');
      if (failedItems.length === 0) {
        alert('当前没有下载失败的条目。');
        return;
      }
      failedItems.forEach(it => it.download_status = 'pending');
      const folderName = `X-Media/${getTaskSafeHandle(state.currentTask)}`;
      chrome.runtime.sendMessage({
        source: 'XMD_CONTENT',
        type: 'START_DOWNLOAD_BATCH',
        payload: {
          items: failedItems,
          folderName,
          concurrency: state.settings.concurrency || 4,
          taskId: state.currentTask.id
        }
      });
      renderDetailDashboard();
    };

    // 重新下载全部
    document.getElementById('btn-redownload-all').onclick = () => {
      if (!confirm('确定要将该任务中的所有媒体重新下载一遍吗？')) return;
      state.currentItems.forEach(it => it.download_status = 'pending');
      const folderName = `X-Media/${getTaskSafeHandle(state.currentTask)}`;
      chrome.runtime.sendMessage({
        source: 'XMD_CONTENT',
        type: 'START_DOWNLOAD_BATCH',
        payload: {
          items: state.currentItems,
          folderName,
          concurrency: state.settings.concurrency || 4,
          taskId: state.currentTask.id
        }
      });
      renderDetailDashboard();
    };

    // 打包所选为 ZIP
    document.getElementById('btn-export-zip').onclick = downloadSelectedAsZip;

    // 导出安卓移动端离线单页
    const exportMobileBtn = document.getElementById('btn-export-mobile');
    if (exportMobileBtn) exportMobileBtn.onclick = exportMobileViewer;

    // 导出/复制直链
    document.getElementById('btn-export-txt').onclick = exportSelectedUrlsTxt;

    // 删除任务
    document.getElementById('btn-delete-task').onclick = () => {
      if (!confirm(`确定要彻底删除该任务及其记录吗？\n博主: @${state.currentTask.x_screen_name}`)) return;
      chrome.runtime.sendMessage({ type: 'DELETE_TASK', payload: { taskId: state.currentTask.id } }, () => {
        switchView('tasks');
      });
    };
  }

  // --- 打包所选媒体为 ZIP ---
  async function downloadSelectedAsZip() {
    const selected = state.currentItems.filter(it => state.selectedIds.has(it.id));
    if (selected.length === 0) {
      alert('请先在下方勾选需要打包的图片或视频！');
      return;
    }

    if (!window.JSZip) {
      alert('JSZip 依赖库未就绪，请使用原生下载或直链导出。');
      return;
    }

    const zip = new window.JSZip();
    const handle = state.currentTask.x_screen_name || 'X_User';
    const folder = zip.folder(`${handle}_selected_media`);

    const btn = document.getElementById('btn-export-zip');
    const origText = btn.textContent;
    btn.disabled = true;

    let completed = 0;
    const total = selected.length;
    let idx = 0;

    async function worker() {
      while (idx < selected.length) {
        const i = idx++;
        const it = selected[i];
        const ext = it.mediaType === 'video' ? 'mp4' : 'jpg';
        const name = `${handle}_${it.tweetId}_${String(i + 1).padStart(3, '0')}.${ext}`;
        try {
          const resp = await fetch(it.mediaUrl);
          const blob = await resp.blob();
          folder.file(name, blob);
        } catch (e) {}
        completed++;
        btn.textContent = `打包中: ${completed}/${total}`;
      }
    }

    const workers = [];
    for (let w = 0; w < 3; w++) workers.push(worker());
    await Promise.all(workers);

    btn.textContent = '正在压缩生成 ZIP...';
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${handle}_selected_${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    btn.disabled = false;
    btn.textContent = origText;
  }

  function exportSelectedUrlsTxt() {
    const selected = state.currentItems.filter(it => state.selectedIds.has(it.id));
    if (selected.length === 0) {
      alert('请先在下方勾选需要导出的图片或视频！');
      return;
    }

    const urls = selected.map(it => it.mediaUrl).join('\n');
    const handle = state.currentTask.x_screen_name || 'X_User';

    navigator.clipboard.writeText(urls).then(() => {
      alert(`已将 ${selected.length} 个媒体直链复制到剪贴板！`);
    });

    const blob = new Blob([urls], { type: 'text/plain;charset=utf-8' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = `${handle}_urls_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(u);
  }

  // 实时下载进度回调
  function onDownloadProgressUpdate(payload) {
    if (!state.currentTask || payload.taskId !== state.currentTask.id) return;

    // 重新拉取一次当前任务详情并更新大屏
    loadTaskDetail(state.currentTask.id);
  }

  // =========================================================================
  // 3. 沉浸式相册级全屏 Lightbox 播放器 (支持左右滑动、全屏切换、手势与键盘交互)
  // =========================================================================
  const lightboxState = {
    items: [],
    currentIndex: 0,
    isSliding: false
  };

  function bindLightboxEvents() {
    const box = document.getElementById('xmd-lightbox');
    const closeBtn = document.getElementById('lightbox-close-btn');
    const prevBtn = document.getElementById('lightbox-prev-btn');
    const nextBtn = document.getElementById('lightbox-next-btn');
    const track = document.getElementById('lightbox-track');
    const stage = document.getElementById('lightbox-stage');

    const cleanBtn = document.getElementById('lightbox-clean-btn');
    const exitCleanBtn = document.getElementById('lightbox-exit-clean-btn');

    function toggleLightboxClean(force) {
      if (!box) return;
      const isClean = typeof force === 'boolean' ? force : !box.classList.contains('clean-mode');
      if (isClean) {
        box.classList.add('clean-mode');
      } else {
        box.classList.remove('clean-mode');
      }
    }

    if (cleanBtn) cleanBtn.onclick = (e) => { e.stopPropagation(); toggleLightboxClean(true); };
    if (exitCleanBtn) exitCleanBtn.onclick = (e) => { e.stopPropagation(); toggleLightboxClean(false); };
    if (closeBtn) closeBtn.onclick = closeLightbox;
    if (prevBtn) prevBtn.onclick = (e) => { e.stopPropagation(); slideTransition('prev'); };
    if (nextBtn) nextBtn.onclick = (e) => { e.stopPropagation(); slideTransition('next'); };

    // 点击背景空白处关闭 (若正处于清屏纯净模式，点击立即退出清屏)
    if (stage) {
      stage.onclick = (e) => {
        if (box && box.classList.contains('clean-mode')) {
          toggleLightboxClean(false);
          return;
        }
        if (e.target === stage || e.target === track || e.target.id === 'lightbox-media-box') {
          closeLightbox();
        }
      };
    }

    // 键盘支持 (左右箭头、A/D翻页、Esc退出、C切换清屏纯净模式、空格播放/暂停)
    document.addEventListener('keydown', (e) => {
      if (!box || !box.classList.contains('xmd-active')) return;
      if (e.key === 'Escape') {
        closeLightbox();
      } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        slideTransition('prev');
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        slideTransition('next');
      } else if (e.key === 'c' || e.key === 'C') {
        toggleLightboxClean();
      } else if (e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        const vid = box.querySelector('video');
        if (vid) {
          e.preventDefault();
          if (vid.paused) vid.play();
          else vid.pause();
        }
      }
    });

    // 移动端全屏相册级滑动手势系统 (左右滑动切换视频/照片，下拉阻尼退出)
    let touchStartX = 0;
    let touchStartY = 0;
    let deltaX = 0;
    let deltaY = 0;
    let startTime = 0;
    let isSwiping = false;
    let gestureDirection = null; // 'h' | 'v' | null

    const onTouchStart = (e) => {
      if (!box || !box.classList.contains('xmd-active')) return;
      if (lightboxState.isSliding) return;
      // 避免点按按钮、链接或文本框时意外拦截
      if (e.target.closest('button, a, .lightbox-tweet-info, input, textarea')) return;

      const t = e.touches[0];
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      deltaX = 0;
      deltaY = 0;
      startTime = Date.now();
      isSwiping = true;
      gestureDirection = null;

      if (track) {
        track.style.transition = 'none';
      }
    };

    const onTouchMove = (e) => {
      if (!isSwiping) return;
      const t = e.touches[0];
      const dx = t.clientX - touchStartX;
      const dy = t.clientY - touchStartY;

      if (!gestureDirection) {
        if (Math.abs(dx) > 10 && Math.abs(dx) >= Math.abs(dy)) {
          gestureDirection = 'h';
        } else if (dy > 12 && dy > Math.abs(dx)) {
          gestureDirection = 'v';
        } else if (Math.abs(dy) > 12) {
          gestureDirection = 'other';
        }
      }

      if (gestureDirection === 'h') {
        // 水平滑动实时跟随手指 (左右滑动切换相册媒体)
        if (e.cancelable) e.preventDefault();
        deltaX = dx;
        if (track) {
          track.style.transform = `translateX(${dx}px)`;
        }
      } else if (gestureDirection === 'v') {
        // 下拉退出手势 (阻尼缩放与背景透明度渐变)
        if (e.cancelable) e.preventDefault();
        deltaY = dy;
        const scale = Math.max(0.72, 1 - dy / 900);
        if (track) {
          track.style.transform = `translate(${dx * 0.3}px, ${dy}px) scale(${scale})`;
        }
        if (box) {
          const alpha = Math.max(0.2, 1 - dy / 450);
          box.style.backgroundColor = `rgba(0, 0, 0, ${alpha})`;
        }
      }
    };

    const onTouchEnd = () => {
      if (!isSwiping) return;
      isSwiping = false;
      const elapsed = Date.now() - startTime;
      const vx = Math.abs(deltaX) / (elapsed || 1);

      if (gestureDirection === 'h') {
        const threshold = 40;
        if (deltaX < -threshold || (deltaX < -20 && vx > 0.3)) {
          slideTransition('next');
        } else if (deltaX > threshold || (deltaX > 20 && vx > 0.3)) {
          slideTransition('prev');
        } else {
          // 弹性回弹复位
          if (track) {
            track.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)';
            track.style.transform = 'translateX(0)';
          }
        }
      } else if (gestureDirection === 'v') {
        if (deltaY > 80) {
          closeLightbox();
        } else {
          // 下拉未达阈值，弹性复位
          if (track) {
            track.style.transition = 'transform 0.22s ease';
            track.style.transform = 'translate(0, 0) scale(1)';
          }
          if (box) box.style.backgroundColor = '';
        }
      }

      gestureDirection = null;
    };

    box.addEventListener('touchstart', onTouchStart, { passive: true });
    box.addEventListener('touchmove', onTouchMove, { passive: false });
    box.addEventListener('touchend', onTouchEnd, { passive: true });
    box.addEventListener('touchcancel', onTouchEnd, { passive: true });
  }

  function slideTransition(direction) {
    if (lightboxState.isSliding) return;
    if (!lightboxState.items || lightboxState.items.length <= 1) {
      const track = document.getElementById('lightbox-track');
      if (track) {
        track.style.transition = 'transform 0.15s ease';
        track.style.transform = direction === 'next' ? 'translateX(-20px)' : 'translateX(20px)';
        setTimeout(() => { track.style.transform = 'translateX(0)'; }, 150);
      }
      return;
    }

    const track = document.getElementById('lightbox-track');
    lightboxState.isSliding = true;

    if (!track) {
      if (direction === 'next') showNextMedia();
      else showPrevMedia();
      lightboxState.isSliding = false;
      return;
    }

    // 1. 快速滑出当前视图
    const outX = direction === 'next' ? '-100vw' : '100vw';
    const inX = direction === 'next' ? '60px' : '-60px';
    track.style.transition = 'transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1)';
    track.style.transform = `translateX(${outX})`;

    setTimeout(() => {
      // 2. 渲染新媒体 (清理前置视频并挂载新视频)
      if (direction === 'next') showNextMedia();
      else showPrevMedia();

      // 3. 将新内容置于微偏移位置并弹性滑入
      track.style.transition = 'none';
      track.style.transform = `translateX(${inX})`;

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          track.style.transition = 'transform 0.24s cubic-bezier(0.2, 0.8, 0.2, 1)';
          track.style.transform = 'translateX(0)';
          setTimeout(() => {
            lightboxState.isSliding = false;
          }, 240);
        });
      });
    }, 160);
  }

  function showNextMedia() {
    if (!lightboxState.items || lightboxState.items.length === 0) return;
    const nextIdx = (lightboxState.currentIndex + 1) % lightboxState.items.length;
    renderLightboxMedia(nextIdx);
  }

  function showPrevMedia() {
    if (!lightboxState.items || lightboxState.items.length === 0) return;
    const prevIdx = (lightboxState.currentIndex - 1 + lightboxState.items.length) % lightboxState.items.length;
    renderLightboxMedia(prevIdx);
  }

  function openLightbox(itemOrList, initialIndex = 0) {
    let list = [];
    let idx = 0;
    if (Array.isArray(itemOrList)) {
      list = itemOrList;
      idx = typeof initialIndex === 'number' ? initialIndex : 0;
    } else if (itemOrList && typeof itemOrList === 'object') {
      const filtered = getFilteredItems();
      const foundIdx = filtered.findIndex(x => x.id === itemOrList.id);
      if (foundIdx !== -1) {
        list = filtered;
        idx = foundIdx;
      } else {
        list = [itemOrList];
        idx = 0;
      }
    }

    if (list.length === 0) return;

    lightboxState.items = list;
    lightboxState.currentIndex = idx;
    lightboxState.isSliding = false;

    const box = document.getElementById('xmd-lightbox');
    const track = document.getElementById('lightbox-track');
    if (track) {
      track.style.transition = 'none';
      track.style.transform = 'translate(0, 0) scale(1)';
    }
    if (box) {
      box.style.backgroundColor = '';
      box.classList.add('xmd-active');
    }

    renderLightboxMedia(idx);
  }

  function renderLightboxMedia(index) {
    if (!lightboxState.items || lightboxState.items.length === 0) return;

    const total = lightboxState.items.length;
    if (index < 0) index = total - 1;
    if (index >= total) index = 0;
    lightboxState.currentIndex = index;

    const item = lightboxState.items[index];
    const container = document.getElementById('lightbox-media-box');
    const counterEl = document.getElementById('lightbox-counter');
    const badgeEl = document.getElementById('lightbox-type-badge');
    const dlBtn = document.getElementById('lightbox-dl-btn');
    const tweetInfo = document.getElementById('lightbox-tweet-info');
    const tweetTextEl = document.getElementById('lightbox-tweet-text');
    const tweetBtn = document.getElementById('lightbox-view-tweet-btn');
    const prevBtn = document.getElementById('lightbox-prev-btn');
    const nextBtn = document.getElementById('lightbox-next-btn');

    // 1. 彻底暂停并重置上一个视频，杜绝后台声音泄漏
    if (container) {
      const oldVid = container.querySelector('video');
      if (oldVid) {
        try {
          oldVid.pause();
          oldVid.removeAttribute('src');
          oldVid.load();
        } catch(e) {}
      }
      container.innerHTML = '';
    }

    // 2. 更新张数计数器与媒体格式标签
    if (counterEl) counterEl.textContent = `${index + 1} / ${total}`;
    if (badgeEl) {
      badgeEl.textContent = item.mediaType === 'video' ? 'MP4' : 'JPG';
      badgeEl.style.background = item.mediaType === 'video' ? 'var(--accent)' : 'var(--success)';
    }

    // 如果只有1张媒体，隐藏翻页按钮
    if (prevBtn && nextBtn) {
      const showArrows = total > 1;
      prevBtn.style.display = showArrows ? 'flex' : 'none';
      nextBtn.style.display = showArrows ? 'flex' : 'none';
    }

    // 3. 创建并渲染媒体元素
    if (item.mediaType === 'video') {
      const vid = document.createElement('video');
      vid.className = 'xmd-gallery-media';
      vid.src = item.mediaUrl;
      vid.controls = true;
      vid.setAttribute('controlslist', 'nodownload');
      vid.autoplay = true;
      vid.playsInline = true;
      vid.setAttribute('webkit-playsinline', 'true');
      vid.preload = 'auto';
      const playPromise = vid.play();
      if (playPromise !== undefined) {
        playPromise.catch(() => {});
      }
      container.appendChild(vid);
    } else {
      const img = document.createElement('img');
      img.className = 'xmd-gallery-media';
      img.src = item.mediaUrl;
      img.alt = item.tweetText || 'Media';
      img.onerror = () => {
        if (item.thumbUrl && img.src !== item.thumbUrl) {
          img.src = item.thumbUrl;
        }
      };
      container.appendChild(img);
    }

    // 4. 原推文文字信息展示
    if (tweetInfo && tweetTextEl) {
      if (item.tweetText && item.tweetText.trim()) {
        tweetTextEl.textContent = item.tweetText;
        tweetInfo.style.display = 'block';
      } else {
        tweetInfo.style.display = 'none';
      }
    }

    // 5. 跳转原推文按钮
    if (tweetBtn) {
      if (item.tweetId && item.tweetId !== 'unknown') {
        tweetBtn.href = `https://x.com/i/status/${item.tweetId}`;
        tweetBtn.style.display = 'inline-flex';
      } else {
        tweetBtn.style.display = 'none';
      }
    }

    // 6. 下载当前文件
    if (dlBtn) {
      dlBtn.onclick = (e) => {
        e.stopPropagation();
        const a = document.createElement('a');
        a.href = item.mediaUrl;
        const ext = item.mediaType === 'video' ? 'mp4' : 'jpg';
        a.download = `${state.currentTask?.x_screen_name || 'X'}_${item.tweetId || 'media'}_${(item.id || '').slice(-4)}.${ext}`;
        a.target = '_blank';
        a.click();
      };
    }
  }

  function closeLightbox() {
    const box = document.getElementById('xmd-lightbox');
    const container = document.getElementById('lightbox-media-box');
    const track = document.getElementById('lightbox-track');
    const tweetInfo = document.getElementById('lightbox-tweet-info');
    if (box) {
      box.classList.remove('xmd-active');
      box.classList.remove('clean-mode');
      box.style.backgroundColor = '';
    }
    if (track) {
      track.style.transition = 'none';
      track.style.transform = 'translate(0, 0) scale(1)';
    }
    if (container) {
      const v = container.querySelector('video');
      if (v) {
        try {
          v.pause();
          v.removeAttribute('src');
          v.load();
        } catch(e) {}
      }
      container.innerHTML = '';
    }
    if (tweetInfo) {
      tweetInfo.style.display = 'none';
    }
    lightboxState.items = [];
    lightboxState.isSliding = false;
  }

  // =========================================================================
  // 4. 设置中心
  // =========================================================================
  async function loadSettings() {
    if (!isExtensionContext) return;
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (cfg) => {
      if (cfg) {
        state.settings = cfg;
        document.getElementById('setting-concurrency').value = cfg.concurrency || 4;
        document.getElementById('val-concurrency').textContent = cfg.concurrency || 4;
        document.getElementById('setting-folder').value = cfg.folderTemplate || 'X-Media/{username}';
        document.getElementById('setting-filename').value = cfg.filenameTemplate || '{username}_{tweet_id}_{index}';
        document.getElementById('setting-skip-rt').checked = cfg.skipRetweets ?? true;
      }
    });
  }

  function bindSettingsEvents() {
    const slider = document.getElementById('setting-concurrency');
    slider.oninput = () => {
      document.getElementById('val-concurrency').textContent = slider.value;
    };

    document.getElementById('btn-save-settings').onclick = () => {
      if (!isExtensionContext) {
        alert('手机端远程观看模式无需调整后台下载线程设置。');
        return;
      }
      const payload = {
        concurrency: parseInt(document.getElementById('setting-concurrency').value) || 4,
        folderTemplate: document.getElementById('setting-folder').value.trim() || 'X-Media/{username}',
        filenameTemplate: document.getElementById('setting-filename').value.trim() || '{username}_{tweet_id}_{index}',
        skipRetweets: document.getElementById('setting-skip-rt').checked
      };

      chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload }, () => {
        state.settings = payload;
        alert('配置已成功保存！');
      });
    };
  }

  // =========================================================================
  // 5. 安卓移动端离线阅读包生成与局域网远程连接
  // =========================================================================
  function bindRemoteHubEvents() {
    // 自动探测本地运行的 Python 远程服务器局域网 IP
    detectRemoteServer().then(info => {
      if (info && info.ip) {
        const input = document.getElementById('remote-ip-input');
        if (input) input.value = info.ip;
        const mobileUrl = `http://${info.ip}:${info.port || 8899}/mobile.html`;
        const pcUrl = `http://${info.ip}:${info.port || 8899}/dashboard.html`;
        const resBox = document.getElementById('remote-url-result');
        if (resBox) {
          resBox.innerHTML = `
            <div>📱 <strong>手机抖音沉浸刷片 (推荐)</strong>: <a href="${mobileUrl}" target="_blank" style="color:var(--success); font-weight:700; word-break:break-all;">${mobileUrl}</a></div>
            <div style="margin-top:6px; font-size:12px; color:var(--text-muted);">💻 电脑完整任务看板: <a href="${pcUrl}" target="_blank" style="color:var(--accent); word-break:break-all;">${pcUrl}</a></div>
          `;
          resBox.style.display = 'block';
        }
      }
    });

    const genBtn = document.getElementById('btn-generate-remote-url');
    if (genBtn) {
      genBtn.onclick = async () => {
        const ip = (document.getElementById('remote-ip-input')?.value || '').trim();
        if (!ip) {
          alert('请先输入电脑在局域网中的 IP 地址（运行 start_remote_server.bat 即可查看）');
          return;
        }
        const srv = await detectRemoteServer();
        const port = srv ? (srv.port || 8899) : 8899;
        const mobileUrl = `http://${ip}:${port}/mobile.html`;
        const pcUrl = `http://${ip}:${port}/dashboard.html`;
        const resBox = document.getElementById('remote-url-result');
        if (resBox) {
          resBox.innerHTML = `
            <div>📱 <strong>手机抖音沉浸刷片 (推荐)</strong>: <a href="${mobileUrl}" target="_blank" style="color:var(--success); font-weight:700; word-break:break-all;">${mobileUrl}</a></div>
            <div style="margin-top:6px; font-size:12px; color:var(--text-muted);">💻 电脑完整任务看板: <a href="${pcUrl}" target="_blank" style="color:var(--accent); word-break:break-all;">${pcUrl}</a></div>
          `;
          resBox.style.display = 'block';
        }
      };
    }

    // 一键推送当前任务及任务库至手机远程服务
    const syncBtn = document.getElementById('btn-sync-to-remote');
    if (syncBtn) {
      syncBtn.onclick = async () => {
        const statusEl = document.getElementById('remote-sync-status');
        if (statusEl) {
          statusEl.style.display = 'block';
          statusEl.style.color = 'var(--text-main)';
          statusEl.textContent = '⏳ 正在全量同步所有博主推文与媒体至手机端服务...';
        }
        if (isExtensionContext) {
          chrome.runtime.sendMessage({ type: 'SYNC_ALL_TO_REMOTE' }, (res) => {
            if (res && res.success) {
              if (statusEl) {
                statusEl.style.color = 'var(--success)';
                statusEl.textContent = `✅ 成功全量同步 ${res.count || 0} 个博主任务！手机刷新即可直接流畅观看！`;
              }
            } else {
              if (statusEl) {
                statusEl.style.color = 'var(--error)';
                statusEl.textContent = '❌ 同步失败，请先双击运行 start_remote_server.bat 确保服务已启动。';
              }
            }
          });
        } else {
          if (statusEl) {
            statusEl.style.color = 'var(--accent)';
            statusEl.textContent = '提示：请在电脑端 Chrome 扩展控制台中点击此按钮同步数据至手机。';
          }
        }
      };
    }
  }

  async function detectRemoteServer() {
    const ports = [8899, 8080, 18080, 28080];
    for (const p of ports) {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/api/lan_info`);
        if (res.ok) {
          const data = await res.json();
          return { baseUrl: `http://127.0.0.1:${p}`, ...data };
        }
      } catch(e) {}
    }
    return null;
  }

  // --- 静默同步辅助函数 ---
  async function syncSingleTaskToRemote(task, items) {
    if (!isExtensionContext || !task) return;
    try {
      const srv = await detectRemoteServer();
      const base = srv ? srv.baseUrl : 'http://127.0.0.1:8899';
      await fetch(`${base}/api/sync_task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, items: items || [] })
      });
    } catch (e) {}
  }

  async function syncAllTasksToRemote() {
    if (!isExtensionContext || !state.tasks || state.tasks.length === 0) return;
    try {
      const srv = await detectRemoteServer();
      const base = srv ? srv.baseUrl : 'http://127.0.0.1:8899';
      await fetch(`${base}/api/sync_all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: state.tasks })
      });
    } catch (e) {}
  }

  // --- 导出安卓移动端原生体验离线阅读单页 (HTML) ---
  function exportMobileViewer() {
    if (!state.currentTask || !state.currentItems || state.currentItems.length === 0) {
      alert('当前任务中没有可导出的推文媒体。');
      return;
    }

    const task = state.currentTask;
    const items = state.currentItems;
    const handle = task.x_screen_name || 'X_User';
    const name = task.x_name || task.task_name || handle;
    const avatar = task.x_avatar || '';
    const bio = task.x_description || '';

    // 按 tweetId 分组生成推文数据对象
    const tweetMap = new Map();
    for (const it of items) {
      const tid = it.tweetId || 'unknown';
      if (!tweetMap.has(tid)) {
        tweetMap.set(tid, {
          tweetId: tid,
          tweetText: it.tweetText || '',
          createdAt: it.createdAt || '',
          user: it.user || { name, screen_name: handle, avatar },
          media: []
        });
      }
      tweetMap.get(tid).media.push({
        id: it.id,
        mediaType: it.mediaType,
        mediaUrl: it.mediaUrl,
        thumbUrl: it.thumbUrl || it.mediaUrl,
        filename: `${handle}_${it.tweetId || 'media'}_${(it.id || '').slice(-4)}.${it.mediaType === 'video' ? 'mp4' : 'jpg'}`
      });
    }

    const tweetsArray = Array.from(tweetMap.values());
    const dataJson = JSON.stringify({
      task: { name, handle, avatar, bio, totalTweets: tweetsArray.length, totalMedia: items.length },
      tweets: tweetsArray
    }).replace(/<\/script>/g, '<\\/script>');

    const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapeHtml(name)} (@${escapeHtml(handle)}) - X 离线推文阅读器</title>
  <style>
    :root {
      --bg: #000000;
      --card-bg: #16181c;
      --border: #2f3336;
      --text: #e7e9ea;
      --text-muted: #71767b;
      --accent: #1d9bf0;
      --accent-hover: #1a8cd8;
      --success: #00ba7c;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding-bottom: 60px;
      -webkit-tap-highlight-color: transparent;
    }
    .header {
      position: sticky;
      top: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 100;
    }
    .profile-card {
      padding: 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 12px;
      background: var(--card-bg);
    }
    .avatar { width: 52px; height: 52px; border-radius: 50%; object-fit: cover; background: #2f3336; flex-shrink: 0; }
    .user-name { font-size: 17px; font-weight: 800; }
    .user-handle { font-size: 13px; color: var(--text-muted); margin-top: 2px; }
    .user-bio { font-size: 14px; color: var(--text); margin-top: 8px; line-height: 1.4; }
    .stats-row { display: flex; gap: 16px; margin-top: 10px; font-size: 13px; color: var(--text-muted); }
    .stats-row strong { color: var(--text); }
    .controls-bar {
      padding: 10px 16px;
      background: #111;
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .search-input {
      flex: 1;
      min-width: 140px;
      background: #202327;
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 6px 14px;
      color: #fff;
      font-size: 13px;
      outline: none;
    }
    .filter-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 16px;
      padding: 5px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    .filter-btn.active {
      background: #fff;
      color: #000;
      font-weight: 700;
      border-color: #fff;
    }
    .tweet-card {
      border-bottom: 1px solid var(--border);
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .tweet-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .tweet-author {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tweet-author-avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; }
    .tweet-author-meta { font-size: 13px; }
    .tweet-author-name { font-weight: 700; color: var(--text); }
    .tweet-author-handle { color: var(--text-muted); font-size: 12px; }
    .tweet-link {
      color: var(--accent);
      text-decoration: none;
      font-size: 12px;
      font-weight: 700;
      padding: 3px 8px;
      background: rgba(29, 155, 240, 0.1);
      border-radius: 4px;
    }
    .tweet-body {
      font-size: 15px;
      line-height: 1.5;
      color: var(--text);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .media-grid {
      display: grid;
      gap: 6px;
      border-radius: 12px;
      overflow: hidden;
      margin-top: 4px;
    }
    .grid-1 { grid-template-columns: 1fr; }
    .grid-2 { grid-template-columns: 1fr 1fr; }
    .grid-3 { grid-template-columns: 1fr 1fr; }
    .grid-4 { grid-template-columns: 1fr 1fr; }
    .media-item {
      position: relative;
      background: #202327;
      overflow: hidden;
      border-radius: 8px;
    }
    .media-img {
      width: 100%;
      height: 100%;
      max-height: 480px;
      object-fit: cover;
      display: block;
    }
    .media-video {
      width: 100%;
      max-height: 480px;
      background: #000;
      border-radius: 8px;
      display: block;
    }
    .tweet-date { font-size: 12px; color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="header">
    <div style="font-weight:800; font-size:16px;">📱 X 离线推文阅读器</div>
    <div style="font-size:12px; color:var(--success); font-weight:700;">● 离线就绪</div>
  </div>

  <div class="profile-card">
    <img class="avatar" src="${escapeHtml(avatar)}" onerror="this.style.display='none'" />
    <div style="flex:1;">
      <div class="user-name">${escapeHtml(name)}</div>
      <div class="user-handle">@${escapeHtml(handle)}</div>
      ${bio ? `<div class="user-bio">${escapeHtml(bio)}</div>` : ''}
      <div class="stats-row">
        <span>推文: <strong>${tweetsArray.length}</strong></span>
        <span>媒体: <strong>${items.length}</strong></span>
      </div>
    </div>
  </div>

  <div class="controls-bar">
    <input type="text" id="searchInput" class="search-input" placeholder="🔍 搜索推文正文内容..." />
    <button class="filter-btn active" data-filter="all">全部</button>
    <button class="filter-btn" data-filter="image">图片</button>
    <button class="filter-btn" data-filter="video">视频</button>
  </div>

  <div id="tweetsContainer"></div>

  <script>
    const DATA = ${dataJson};
    let activeFilter = 'all';
    let searchQuery = '';

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function render() {
      const container = document.getElementById('tweetsContainer');
      container.innerHTML = '';

      let list = DATA.tweets;
      if (activeFilter === 'image') {
        list = list.filter(t => t.media.some(m => m.mediaType === 'image'));
      } else if (activeFilter === 'video') {
        list = list.filter(t => t.media.some(m => m.mediaType === 'video'));
      }

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        list = list.filter(t => (t.tweetText || '').toLowerCase().includes(q));
      }

      if (list.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:40px; color:#71767b; font-size:14px;">没有匹配的推文</div>';
        return;
      }

      for (const t of list) {
        const card = document.createElement('div');
        card.className = 'tweet-card';

        const tweetUrl = t.tweetId && t.tweetId !== 'unknown' ? 'https://x.com/i/status/' + t.tweetId : '';
        const author = t.user || DATA.task;

        let dateStr = '';
        if (t.createdAt) {
          try {
            const d = new Date(t.createdAt);
            dateStr = (d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
          } catch(e) {}
        }

        let mediaHtml = '';
        if (t.media && t.media.length > 0) {
          const gridClass = 'grid-' + Math.min(4, t.media.length);
          mediaHtml = '<div class="media-grid ' + gridClass + '">';
          for (const m of t.media) {
            if (m.mediaType === 'video') {
              mediaHtml += '<div class="media-item"><video class="media-video" src="' + m.mediaUrl + '" poster="' + m.thumbUrl + '" controls playsinline preload="metadata"></video></div>';
            } else {
              mediaHtml += '<div class="media-item"><img class="media-img" src="' + m.mediaUrl + '" loading="lazy" /></div>';
            }
          }
          mediaHtml += '</div>';
        }

        card.innerHTML = \`
          <div class="tweet-header">
            <div class="tweet-author">
              <img class="tweet-author-avatar" src="\${escapeHtml(author.avatar || '')}" onerror="this.style.display='none'" />
              <div class="tweet-author-meta">
                <span class="tweet-author-name">\${escapeHtml(author.name || DATA.task.name)}</span>
                <span class="tweet-author-handle">@\${escapeHtml(author.screen_name || DATA.task.handle)}</span>
              </div>
            </div>
            \${tweetUrl ? '<a href="' + tweetUrl + '" target="_blank" class="tweet-link">在 X 查看 ↗</a>' : ''}
          </div>
          \${t.tweetText ? '<div class="tweet-body">' + escapeHtml(t.tweetText) + '</div>' : ''}
          \${mediaHtml}
          \${dateStr ? '<div class="tweet-date">' + dateStr + '</div>' : ''}
        \`;

        container.appendChild(card);
      }
    }

    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.getAttribute('data-filter');
        render();
      };
    });

    document.getElementById('searchInput').oninput = (e) => {
      searchQuery = e.target.value.trim();
      render();
    };

    render();
  </script>
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = `X_${handle}_mobile_offline_${Date.now()}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(u);
    alert(`🎉 移动端离线阅读包生成成功！\n文件: X_${handle}_mobile_offline.html\n\n你可以直接将此 HTML 文件发送到安卓手机（微信、QQ、数据线拷贝），在手机任何浏览器中直接打开即可离线刷推！`);
  }

})();
