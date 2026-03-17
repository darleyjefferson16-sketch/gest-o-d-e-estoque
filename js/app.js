/* =====================================================
   APP.JS - Shared UI (Sidebar, Notifications, etc.)
   ===================================================== */

const UI = {

  /* ---------- SIDEBAR ---------- */
  renderSidebar(activePage) {
    const session = Auth.getSession();
    if (!session) return;

    const isAdmin = Auth.isAdmin();
    const isDev = Auth.isDev();
    const isUser = session.userRole === 'Usuário';

    const stats = DB.getStats();
    const pendingBadge = stats.pendingRequisitions > 0
      ? `<span class="badge">${stats.pendingRequisitions}</span>` : '';

    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const navLinks = [
      { href: 'dashboard.html', icon: 'fa-table-cells-large', label: 'Dashboard', page: 'dashboard' },
      { href: 'estoque.html', icon: 'fa-boxes', label: 'Estoque', page: 'estoque' },
      { href: 'mapa-estoque.html', icon: 'fa-map', label: 'Mapa do Estoque', page: 'mapa' },
      ...(!isUser ? [
        { href: 'entrada.html', icon: 'fa-circle-arrow-down', label: 'Entrada', page: 'entrada' },
        { href: 'saida.html', icon: 'fa-circle-arrow-up', label: 'Saída', page: 'saida' },
      ] : []),
      { href: 'requisicoes.html', icon: 'fa-clipboard-list', label: 'Requisições', page: 'requisicoes', badge: pendingBadge },
      ...(!isUser ? [
        { href: 'ferramentas.html', icon: 'fa-wrench', label: 'Ferramentas', page: 'ferramentas' },
      ] : []),
      { href: 'historico.html', icon: 'fa-clock-rotate-left', label: 'Histórico', page: 'historico' },
    ];

    const adminLinks = isAdmin ? [
      { href: 'usuarios.html', icon: 'fa-users', label: 'Usuários', page: 'usuarios' },
    ] : [];

    const devLinks = isDev ? [
      { href: 'desenvolvedor.html', icon: 'fa-code', label: 'Painel Dev', page: 'desenvolvedor' },
    ] : [];

    const renderLinks = (links) => links.map(l => `
      <a href="${l.href}" class="${activePage === l.page ? 'active' : ''}">
        <i class="fas ${l.icon}"></i>
        <span>${l.label}</span>
        ${l.badge || ''}
      </a>
    `).join('');

    sidebar.innerHTML = `
      <div class="sidebar-logo">
        <div class="sidebar-logo-icon"><i class="fas fa-warehouse"></i></div>
        <div class="sidebar-logo-text">
          <h1>Controle de Estoque</h1>
          <span>Gestão de Almoxarifado</span>
        </div>
      </div>
      <nav class="sidebar-nav">
        <div class="sidebar-section">Principal</div>
        ${renderLinks(navLinks)}
        ${isAdmin ? `<div class="sidebar-section">Administração</div>${renderLinks(adminLinks)}` : ''}
        ${isDev ? `<div class="sidebar-section">Desenvolvimento</div>${renderLinks(devLinks)}` : ''}
      </nav>
      <div class="sidebar-user">
        <div class="sidebar-user-avatar">${session.userName.charAt(0).toUpperCase()}</div>
        <div class="sidebar-user-info">
          <strong>${Utils.esc(session.userName)}</strong>
          <span>${Utils.esc(session.userRole)}</span>
        </div>
        <a href="#" onclick="Auth.logout()" title="Sair"><i class="fas fa-right-from-bracket"></i></a>
      </div>
    `;
  },

  /* ---------- TOPBAR SEARCH ---------- */
  initSearch() {
    const searchInput = document.getElementById('global-search');
    const resultsBox = document.getElementById('search-results');
    if (!searchInput || !resultsBox) return;

    let timeout;
    searchInput.addEventListener('input', () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        const query = searchInput.value.trim();
        if (query.length < 2) {
          resultsBox.classList.remove('active');
          return;
        }
        const results = Utils.globalSearch(query);
        if (results.length === 0) {
          resultsBox.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">Nenhum resultado</div>';
        } else {
          resultsBox.innerHTML = results.map(r => `
            <a class="search-result-item" href="${r.href}">
              <div class="search-result-icon"><i class="fas ${r.icon}"></i></div>
              <div class="search-result-info">
                <strong>${Utils.esc(r.label)}</strong>
                <span>${Utils.esc(r.sub)}</span>
              </div>
              <span class="badge badge-muted">${r.type}</span>
            </a>
          `).join('');
        }
        resultsBox.classList.add('active');
      }, 250);
    });

    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !resultsBox.contains(e.target)) {
        resultsBox.classList.remove('active');
      }
    });
  },

  /* ---------- SIDEBAR MOBILE TOGGLE ---------- */
  initMobileToggle() {
    const toggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (!toggle || !sidebar) return;

    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      if (overlay) overlay.classList.toggle('active');
    });

    if (overlay) {
      overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
      });
    }
  },

  /* ---------- NOTIFICATIONS ---------- */
  notify(message, type = 'info', duration = 4000) {
    const container = document.getElementById('notifications') || (() => {
      const el = document.createElement('div');
      el.id = 'notifications';
      el.className = 'notifications-container';
      document.body.appendChild(el);
      return el;
    })();

    const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };

    const el = document.createElement('div');
    el.className = `notification ${type}`;
    el.innerHTML = `
      <i class="fas ${icons[type] || icons.info}"></i>
      <span class="notification-text">${Utils.esc(message)}</span>
      <button class="notification-close" onclick="this.parentElement.remove()"><i class="fas fa-xmark"></i></button>
    `;
    container.appendChild(el);

    if (duration > 0) {
      setTimeout(() => el.remove(), duration);
    }
  },

  /* ---------- CONFIRM DIALOG ---------- */
  confirm(message, title = 'Confirmar') {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay active';
      overlay.innerHTML = `
        <div class="modal modal-sm">
          <div class="modal-header">
            <span class="modal-title">${Utils.esc(title)}</span>
          </div>
          <div class="modal-body">
            <p style="color:var(--text-secondary)">${Utils.esc(message)}</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" id="conf-cancel">Cancelar</button>
            <button class="btn btn-danger" id="conf-ok">Confirmar</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      overlay.querySelector('#conf-cancel').onclick = () => { overlay.remove(); resolve(false); };
      overlay.querySelector('#conf-ok').onclick = () => { overlay.remove(); resolve(true); };
      overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
    });
  },

  /* ---------- MODAL HELPERS ---------- */
  openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
  },

  closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  },

  /* ---------- TABS ---------- */
  initTabs(containerSelector) {
    document.querySelectorAll(containerSelector || '.tabs').forEach(tabContainer => {
      tabContainer.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const target = btn.dataset.tab;
          tabContainer.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const parent = tabContainer.closest('.card') || tabContainer.parentElement;
          parent.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
          const targetEl = document.getElementById(target) || parent.querySelector(`.tab-content[data-tab="${target}"]`);
          if (targetEl) targetEl.classList.add('active');
        });
      });
    });
  },

  /* ---------- PAGINATION ---------- */
  paginate(items, page, perPage = 15) {
    const totalPages = Math.ceil(items.length / perPage);
    const start = (page - 1) * perPage;
    const end = start + perPage;
    return {
      items: items.slice(start, end),
      totalPages,
      currentPage: page,
      total: items.length,
    };
  },

  /* onPage must be a function reference (e.g. a named function or arrow stored in a variable).
     Pages are rendered as data-page buttons; a single delegated listener handles navigation. */
  renderPagination(container, currentPage, totalPages, onPage) {
    if (!container) return;
    if (totalPages <= 1) { container.innerHTML = ''; return; }

    let pages = '';
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
        pages += `<button class="btn btn-sm ${i === currentPage ? 'btn-primary' : 'btn-ghost'}" data-page="${i}">${i}</button>`;
      } else if (i === currentPage - 3 || i === currentPage + 3) {
        pages += `<span style="color:var(--text-muted);padding:0 4px">...</span>`;
      }
    }

    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;justify-content:center;margin-top:16px;">
        <button class="btn btn-sm btn-ghost" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>
          <i class="fas fa-chevron-left"></i>
        </button>
        ${pages}
        <button class="btn btn-sm btn-ghost" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>
          <i class="fas fa-chevron-right"></i>
        </button>
      </div>
    `;

    /* Single delegated listener — replaces any previous one by re-rendering the container */
    container.onclick = (e) => {
      const btn = e.target.closest('[data-page]');
      if (!btn || btn.disabled) return;
      const page = parseInt(btn.dataset.page, 10);
      if (page >= 1 && page <= totalPages) onPage(page);
    };
  },

  /* ---------- INIT ALL ---------- */
  init(activePage) {
    this.renderSidebar(activePage);
    this.initSearch();
    this.initMobileToggle();
    this.initTabs();
  },
};

/* =====================================================
   QR SCANNER HELPER
   ===================================================== */
const Scanner = {
  html5Qr: null,

  start(elementId, onSuccess) {
    if (typeof Html5Qrcode === 'undefined') {
      UI.notify('Biblioteca de scanner não carregada', 'error');
      return;
    }

    this.html5Qr = new Html5Qrcode(elementId);
    Html5Qrcode.getCameras().then(cameras => {
      if (!cameras || cameras.length === 0) {
        UI.notify('Nenhuma câmera encontrada', 'error');
        return;
      }
      const cameraId = cameras[cameras.length - 1].id;
      this.html5Qr.start(
        cameraId,
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          this.stop();
          onSuccess(decodedText);
        },
        () => {}
      ).catch(err => {
        UI.notify('Erro ao iniciar câmera: ' + err, 'error');
      });
    }).catch(() => {
      UI.notify('Erro ao acessar câmeras', 'error');
    });
  },

  stop() {
    if (this.html5Qr) {
      this.html5Qr.stop().catch(() => {});
      this.html5Qr = null;
    }
  },
};
