/* =====================================================
   AUTH.JS - Sistema de Autenticação
   ===================================================== */

const Auth = {

  SESSION_KEY: 'ce_session',

  /* ---------- LOGIN (async — uses PBKDF2 verification) ---------- */
  async login(email, password) {
    /* Verificar bloqueio antes de qualquer consulta de usuário */
    const locked = DB.isLocked(email);
    if (locked) {
      const unlockTime = new Date(locked).toLocaleTimeString('pt-BR');
      return { error: `Conta bloqueada. Tente novamente após ${unlockTime}.`, blocked: true };
    }

    const user = DB.getUserByEmail(email);

    /* Verificar se a conta está ativa ANTES de checar a senha.
       Sempre retornar mensagem genérica para não vazar informação. */
    if (!user || !user.active) {
      DB.incrementAttempts(email);
      return { error: 'Email ou senha incorretos.' };
    }

    const valid = await DB.verifyPassword(password, user.password);

    if (!valid) {
      const attempt = DB.incrementAttempts(email);
      const remaining = 5 - attempt.count;
      const msg = remaining > 0
        ? `Email ou senha incorretos. ${remaining} tentativa(s) restante(s).`
        : 'Conta bloqueada por 15 minutos após muitas tentativas.';
      return { error: msg };
    }

    /* Login bem-sucedido */
    DB.resetAttempts(email);

    /* Migrar hash legado (djb2) para PBKDF2 de forma transparente */
    if (!user.password.startsWith('pbkdf2:')) {
      user.password = await DB.hashPassword(password);
      DB.saveUser(user);
    }

    const session = {
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      loginAt: new Date().toISOString(),
    };

    localStorage.setItem(this.SESSION_KEY, JSON.stringify(session));

    user.lastLogin = new Date().toISOString();
    DB.saveUser(user);

    DB.addLog('ACTION', user.id, user.name, 'Login realizado');

    return { success: true, user, session };
  },

  /* ---------- LOGOUT ---------- */
  logout() {
    const session = this.getSession();
    if (session) {
      DB.addLog('ACTION', session.userId, session.userName, 'Logout realizado');
    }
    localStorage.removeItem(this.SESSION_KEY);
    window.location.href = 'login.html';
  },

  /* ---------- SESSÃO ---------- */
  getSession() {
    try {
      const data = localStorage.getItem(this.SESSION_KEY);
      return data ? JSON.parse(data) : null;
    } catch { return null; }
  },

  isAuthenticated() {
    return !!this.getSession();
  },

  /* ---------- VERIFICAÇÃO DE ROTA ---------- */
  requireAuth() {
    if (!this.isAuthenticated()) {
      window.location.href = 'login.html';
      return null;
    }
    return this.getSession();
  },

  requireRole(...roles) {
    const session = this.requireAuth();
    if (!session) return null;
    if (!roles.includes(session.userRole)) {
      UI.notify('Acesso negado. Permissão insuficiente.', 'error');
      setTimeout(() => window.location.href = 'dashboard.html', 1500);
      return null;
    }
    return session;
  },

  isAdmin() {
    const s = this.getSession();
    return s && (s.userRole === 'Administrador' || s.userRole === 'Desenvolvedor');
  },

  isDev() {
    const s = this.getSession();
    return s && s.userRole === 'Desenvolvedor';
  },

  isAlmoxarife() {
    const s = this.getSession();
    return s && (s.userRole === 'Almoxarife' || s.userRole === 'Administrador' || s.userRole === 'Desenvolvedor');
  },

  isUser() {
    const s = this.getSession();
    return s && s.userRole === 'Usuário';
  },

  /* Bloqueia acesso de perfil Usuário — redireciona para dashboard */
  denyUser() {
    const s = this.requireAuth();
    if (!s) return null;
    if (s.userRole === 'Usuário') {
      UI.notify('Acesso negado. Seu perfil não tem permissão para esta página.', 'error');
      setTimeout(() => window.location.href = 'dashboard.html', 1500);
      return null;
    }
    return s;
  },

  /* ---------- RESET DE SENHA (async — gera PBKDF2) ---------- */
  async adminResetPassword(userId, newPassword, adminId, adminName) {
    const user = DB.getUser(userId);
    if (!user) return { error: 'Usuário não encontrado.' };
    user.password = await DB.hashPassword(newPassword);
    DB.saveUser(user);
    DB.addLog('ACTION', adminId, adminName, `Senha do usuário ${user.name} resetada pelo administrador`);
    return { success: true };
  },
};
