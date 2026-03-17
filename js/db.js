/* =====================================================
   DB.JS - Camada de Dados (Firestore + LocalStorage)
   Controle de Estoque - SaaS
   ===================================================== */

const DB = {

  /* ---------- CHAVES ---------- */
  KEYS: {
    USERS: 'ce_users',
    PRODUCTS: 'ce_products',
    ENTRIES: 'ce_entries',
    EXITS: 'ce_exits',
    REQUISITIONS: 'ce_requisitions',
    TOOLS: 'ce_tools',
    MOVEMENTS: 'ce_movements',
    LOGS: 'ce_logs',
    BACKUPS: 'ce_backups',
    SETTINGS: 'ce_settings',
    SESSION: 'ce_session',
    LOGIN_ATTEMPTS: 'ce_login_attempts',
  },

  _db: null,
  _cache: {},
  _online: false,
  _writing: {},
  _initError: null,
  _log: [], /* debug log */

  _debug(msg) {
    const line = '[' + new Date().toISOString().substr(11,8) + '] ' + msg;
    this._log.push(line);
    /* Acumular log entre páginas via sessionStorage */
    try {
      const prev = JSON.parse(sessionStorage.getItem('_db_log') || '[]');
      prev.push(line);
      sessionStorage.setItem('_db_log', JSON.stringify(prev.slice(-80)));
    } catch {}
    console.log('[DB]', msg);
  },

  /* ---------- INICIALIZAÇÃO ---------- */
  async init() {
    this._log = [];
    this._debug('init() started');
    this._ensureSettings();
    this._loadFromLocalStorage();

    const localUsers = this._cache[this.KEYS.USERS];
    this._debug('localStorage users: ' + (localUsers ? localUsers.length : 0));

    try {
      const hasConfig = (
        typeof firebase !== 'undefined' &&
        typeof FIREBASE_CONFIG !== 'undefined' &&
        FIREBASE_CONFIG.apiKey &&
        FIREBASE_CONFIG.apiKey !== 'COLE_AQUI' &&
        FIREBASE_CONFIG.databaseURL
      );

      this._debug('hasConfig: ' + hasConfig);

      if (hasConfig) {
        if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
        this._db = firebase.database();
        this._debug('Firebase initialized, loading RTDB...');

        await Promise.race([
          this._loadFromRTDB(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 8s')), 8000)),
        ]);

        const rtdbUsers = this._cache[this.KEYS.USERS];
        this._debug('After RTDB load, users in cache: ' + (rtdbUsers ? rtdbUsers.length : 0));

        this._setupRealtimeSync();
        this._online = true;
        this._initError = null;
      }
    } catch (e) {
      this._online = false;
      this._initError = e.message || String(e);
      this._debug('Firebase ERROR: ' + this._initError);
    }

    const finalUsers = this.get(this.KEYS.USERS);
    this._debug('Pre-seed users: ' + (finalUsers ? finalUsers.length : 0));

    if (!finalUsers || finalUsers.length === 0) {
      this._debug('Running SEED...');
      await this._seed();
      this._debug('Seed done. Users: ' + (this.get(this.KEYS.USERS) || []).length);
    } else {
      this._debug('No seed needed.');
    }

    this._scheduleAutoBackup();
    this._debug('init() complete. online=' + this._online);
  },

  /* ---------- HELPERS RTDB ---------- */
  /* Lê um valor do Firebase independente do formato histórico */
  _parseRTDBSnap(raw) {
    if (raw === null || raw === undefined) return { value: null, savedAt: 0 };

    /* Formato atual: { data: "[...]", savedAt: 123456 } */
    if (raw && typeof raw.data === 'string') {
      try {
        return { value: JSON.parse(raw.data), savedAt: raw.savedAt || 0 };
      } catch { return { value: null, savedAt: 0 }; }
    }

    /* Formato antigo 1: { __data: [...] } */
    if (raw && raw.__data !== undefined) {
      return { value: raw.__data, savedAt: 0 };
    }

    /* Formato antigo 2: string JSON direta */
    if (typeof raw === 'string') {
      try { return { value: JSON.parse(raw), savedAt: 0 }; } catch {}
    }

    /* Formato antigo 3: objeto bruto (array convertido pelo RTDB) → inválido */
    return { value: null, savedAt: 0 };
  },

  /* Carrega todas as coleções do Realtime Database para o cache */
  async _loadFromRTDB() {
    const keys = Object.values(this.KEYS).filter(
      k => k !== this.KEYS.SESSION && k !== this.KEYS.LOGIN_ATTEMPTS
    );
    await Promise.all(keys.map(async key => {
      try {
        const snap = await this._db.ref('store/' + key).get();
        const localTs = parseInt(localStorage.getItem(key + '_ts') || '0');
        const localVal = this._cache[key]; /* já carregado do localStorage */

        if (!snap.exists()) {
          /* RTDB vazio — migrar dado local */
          if (localVal !== undefined && localVal !== null) {
            const ts = localTs || Date.now();
            this._db.ref('store/' + key)
              .set({ data: JSON.stringify(localVal), savedAt: ts })
              .catch(() => {});
          }
          return;
        }

        const { value, savedAt: rtdbTs } = this._parseRTDBSnap(snap.val());

        /* Valor inválido ou nulo no RTDB — usar local e reescrever RTDB */
        if (value === null || value === undefined) {
          if (localVal !== undefined && localVal !== null) {
            const ts = localTs || Date.now();
            this._db.ref('store/' + key)
              .set({ data: JSON.stringify(localVal), savedAt: ts })
              .catch(() => {});
          }
          return;
        }

        /* Comparar timestamps: usar o mais recente */
        if (rtdbTs >= localTs) {
          /* RTDB é mais recente (ou igual) */
          this._cache[key] = value;
          localStorage.setItem(key, JSON.stringify(value));
          localStorage.setItem(key + '_ts', rtdbTs);
        } else {
          /* Local é mais recente — reescrever RTDB com formato novo */
          if (localVal !== undefined && localVal !== null) {
            this._db.ref('store/' + key)
              .set({ data: JSON.stringify(localVal), savedAt: localTs })
              .catch(() => {});
          }
        }

        /* Converter formato antigo para o novo no RTDB */
        if (rtdbTs === 0 && value !== null) {
          const ts = localTs || Date.now();
          this._db.ref('store/' + key)
            .set({ data: JSON.stringify(this._cache[key]), savedAt: ts })
            .catch(() => {});
          localStorage.setItem(key + '_ts', ts);
        }

      } catch (e) {
        console.warn('RTDB load error [' + key + ']:', e.message);
      }
    }));
  },

  /* Sincronização em tempo real via onValue */
  _setupRealtimeSync() {
    const keys = Object.values(this.KEYS).filter(
      k => k !== this.KEYS.SESSION && k !== this.KEYS.LOGIN_ATTEMPTS
    );
    keys.forEach(key => {
      this._db.ref('store/' + key).on('value', snap => {
        if (this._writing[key]) return;
        if (!snap.exists()) return;
        try {
          const { value, savedAt: rtdbTs } = this._parseRTDBSnap(snap.val());
          if (value === null) return;
          const localTs = parseInt(localStorage.getItem(key + '_ts') || '0');
          if (rtdbTs <= localTs) return;
          this._cache[key] = value;
          localStorage.setItem(key, JSON.stringify(value));
          localStorage.setItem(key + '_ts', rtdbTs);
        } catch {}
      });
    });
  },

  /* Carrega localStorage inteiro para o cache (modo offline) */
  _loadFromLocalStorage() {
    Object.values(this.KEYS).forEach(key => {
      try {
        const data = localStorage.getItem(key);
        if (data) this._cache[key] = JSON.parse(data);
      } catch {}
    });
  },

  async _seed() {
    const now = new Date().toISOString();
    const [adminHash, devHash, almoHash, darleyHash] = await Promise.all([
      this.hashPassword('Admin@123'),
      this.hashPassword('Dev@123'),
      this.hashPassword('Almo@123'),
      this.hashPassword('Dj.85304843'),
    ]);

    const users = [
      {
        id: this._uuid(),
        name: 'Administrador',
        email: 'admin@sistema.com',
        password: adminHash,
        role: 'Administrador',
        sector: 'TI',
        position: 'Administrador do Sistema',
        active: true,
        createdAt: now,
        createdBy: 'sistema',
        lastLogin: null,
      },
      {
        id: this._uuid(),
        name: 'Desenvolvedor',
        email: 'dev@sistema.com',
        password: devHash,
        role: 'Desenvolvedor',
        sector: 'TI',
        position: 'Desenvolvedor',
        active: true,
        createdAt: now,
        createdBy: 'sistema',
        lastLogin: null,
      },
      {
        id: this._uuid(),
        name: 'Almoxarife Padrão',
        email: 'almoxarife@sistema.com',
        password: almoHash,
        role: 'Almoxarife',
        sector: 'Almoxarifado',
        position: 'Almoxarife',
        active: true,
        createdAt: now,
        createdBy: 'sistema',
        lastLogin: null,
      },
      {
        id: this._uuid(),
        name: 'Darley',
        email: 'darley.jefferson16@gmail.com',
        password: darleyHash,
        role: 'Desenvolvedor',
        sector: 'TI',
        position: 'Desenvolvedor',
        active: true,
        createdAt: now,
        createdBy: 'sistema',
        lastLogin: null,
      },
    ];
    this.set(this.KEYS.USERS, users);

    const products = [
      this._makeProduct('Parafuso M10 Sextavado', 'Fixação', 'Parafuso sextavado galvanizado M10 x 50mm', 150, 'unidade', 30, 'A', '1', '1', 'A'),
      this._makeProduct('Luva Isolante 1000V', 'EPI', 'Luva de segurança isolante para eletricistas', 8, 'par', 5, 'A', '1', '2', 'A'),
      this._makeProduct('Disjuntor Bipolar 63A', 'Elétrica', 'Disjuntor bipolar DIN 63A', 12, 'unidade', 5, 'A', '2', '1', 'B'),
      this._makeProduct('Cabo PP 2x2,5mm', 'Elétrica', 'Rolo 100m de cabo PP flexível 2x2,5mm', 5, 'rolo', 2, 'B', '1', '1', 'A'),
      this._makeProduct('Fita Isolante 19mm', 'Elétrica', 'Fita isolante preta 19mm x 10m', 40, 'unidade', 10, 'B', '1', '1', 'B'),
      this._makeProduct('Capacete de Segurança', 'EPI', 'Capacete de proteção classe B amarelo', 3, 'unidade', 5, 'B', '2', '1', 'A'),
      this._makeProduct('Óculos de Proteção', 'EPI', 'Óculos de segurança incolor antirrisco', 15, 'unidade', 5, 'B', '2', '2', 'A'),
      this._makeProduct('Mangueira 3/4 pol.', 'Hidráulica', 'Mangueira PVC 3/4 pol. - metro', 200, 'metro', 50, 'C', '1', '1', 'A'),
    ];
    this.set(this.KEYS.PRODUCTS, products);

    const movements = [];
    products.forEach(p => {
      movements.push({
        id: this._uuid(),
        productId: p.id,
        productCode: p.code,
        productName: p.name,
        type: 'entrada',
        quantity: p.quantity,
        balance: p.quantity,
        date: now,
        userId: users[0].id,
        userName: users[0].name,
        observation: 'Estoque inicial',
        reference: null,
      });
    });
    this.set(this.KEYS.MOVEMENTS, movements);

    const tools = [
      {
        id: this._uuid(),
        name: 'Furadeira de Impacto Bosch',
        code: this._toolCode(),
        patrimony: 'PAT-001',
        category: 'Elétrica',
        status: 'disponivel',
        borrowedBy: null,
        borrowedDate: null,
        returnDate: null,
        observation: '',
        createdAt: now,
      },
      {
        id: this._uuid(),
        name: 'Multímetro Digital',
        code: this._toolCode(),
        patrimony: 'PAT-002',
        category: 'Medição',
        status: 'emprestado',
        borrowedBy: 'João Silva',
        borrowedDate: new Date(Date.now() - 3 * 86400000).toISOString(),
        returnDate: new Date(Date.now() + 2 * 86400000).toISOString(),
        observation: 'Manutenção preventiva',
        createdAt: now,
      },
    ];
    this.set(this.KEYS.TOOLS, tools);

    this.set(this.KEYS.ENTRIES, []);
    this.set(this.KEYS.EXITS, []);
    this.set(this.KEYS.REQUISITIONS, []);
    this.set(this.KEYS.LOGS, []);
    this.set(this.KEYS.BACKUPS, []);
  },

  _makeProduct(name, category, description, quantity, unit, minStock, corridor, shelf, rack, position) {
    const code = this._productCode();
    return {
      id: this._uuid(),
      code,
      name,
      category,
      description,
      quantity,
      unit,
      minStock,
      location: { corridor, shelf, rack, position },
      createdAt: new Date().toISOString(),
      createdBy: 'sistema',
      qrData: code,
    };
  },

  _ensureSettings() {
    if (!this.get(this.KEYS.SETTINGS)) {
      this.set(this.KEYS.SETTINGS, {
        companyName: 'Minha Empresa',
        backupInterval: 30,
        lastBackup: null,
        categories: ['Elétrica', 'Fixação', 'EPI', 'Hidráulica', 'Ferramentas', 'Limpeza', 'Informática', 'Medição', 'Outros'],
        counters: { product: 0, req: 0, tool: 0 },
      });
    } else {
      /* Ensure counters object exists for existing installs */
      const settings = this.get(this.KEYS.SETTINGS);
      if (!settings.counters) {
        const products = this.getProducts();
        const reqs = this.getRequisitions();
        const tools = this.getTools();
        settings.counters = {
          product: products.length,
          req: reqs.length,
          tool: tools.length,
        };
        this.set(this.KEYS.SETTINGS, settings);
      }
    }
  },

  /* ---------- CRUD GENÉRICO ---------- */
  get(key) {
    /* SESSION e LOGIN_ATTEMPTS ficam apenas no localStorage (por dispositivo) */
    if (key === this.KEYS.SESSION || key === this.KEYS.LOGIN_ATTEMPTS) {
      try {
        const data = localStorage.getItem(key);
        return data ? JSON.parse(data) : null;
      } catch { return null; }
    }
    return this._cache[key] ?? null;
  },

  set(key, value) {
    /* SESSION e LOGIN_ATTEMPTS ficam apenas no localStorage */
    if (key === this.KEYS.SESSION || key === this.KEYS.LOGIN_ATTEMPTS) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch { return false; }
    }

    /* Atualizar cache imediatamente (leituras síncronas continuam funcionando) */
    this._cache[key] = value;

    /* Persistir no localStorage como fallback offline */
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
        const msg = 'Armazenamento local cheio! Exporte um backup e remova dados antigos para continuar.';
        if (typeof UI !== 'undefined') UI.notify(msg, 'error', 0);
        else alert(msg);
      }
    }

    /* Gravar no Realtime Database — merge para não apagar dados de outros dispositivos */
    if (this._db) {
      const ts = Date.now();
      localStorage.setItem(key + '_ts', ts);
      this._writing[key] = true;
      this._debug('SET ' + key + ' ts=' + ts + (Array.isArray(value) ? ' len=' + value.length : ''));

      /* Ler RTDB atual, fazer merge (preservar itens ausentes no local) e gravar */
      this._db.ref('store/' + key).get().then(snap => {
        let toWrite = value;

        if (snap.exists() && Array.isArray(value)) {
          const { value: rtdbVal } = this._parseRTDBSnap(snap.val());
          if (Array.isArray(rtdbVal)) {
            const localIds = new Set(value.map(u => u.id).filter(Boolean));
            const extra = rtdbVal.filter(u => u.id && !localIds.has(u.id));
            if (extra.length > 0) {
              toWrite = [...value, ...extra];
              /* Atualizar cache e localStorage com dados mesclados */
              this._cache[key] = toWrite;
              localStorage.setItem(key, JSON.stringify(toWrite));
              this._debug('MERGE ' + key + ' +' + extra.length + ' itens do RTDB → len=' + toWrite.length);
            }
          }
        }

        return this._db.ref('store/' + key).set({ data: JSON.stringify(toWrite), savedAt: ts });
      }).then(() => {
        this._debug('SET OK ' + key);
        setTimeout(() => { this._writing[key] = false; }, 500);
      }).catch(e => {
        this._writing[key] = false;
        this._debug('SET FAIL ' + key + ': ' + e.message);
        if (typeof UI !== 'undefined' && typeof UI.notify === 'function') {
          UI.notify('Erro ao salvar: ' + e.message, 'error');
        } else {
          alert('Erro ao salvar no servidor: ' + e.message);
        }
      });
    }

    return true;
  },

  /* ---------- USERS ---------- */
  getUsers() { return this.get(this.KEYS.USERS) || []; },
  getUser(id) { return this.getUsers().find(u => u.id === id); },
  getUserByEmail(email) { return this.getUsers().find(u => u.email.toLowerCase() === email.toLowerCase()); },

  saveUser(user) {
    const users = this.getUsers();
    const idx = users.findIndex(u => u.id === user.id);
    if (idx >= 0) users[idx] = user;
    else users.push(user);
    this.set(this.KEYS.USERS, users);
    return user;
  },

  deleteUser(id) {
    const users = this.getUsers().filter(u => u.id !== id);
    this.set(this.KEYS.USERS, users);
  },

  /* ---------- PRODUCTS ---------- */
  getProducts() { return this.get(this.KEYS.PRODUCTS) || []; },
  getProduct(id) { return this.getProducts().find(p => p.id === id); },
  getProductByCode(code) { return this.getProducts().find(p => p.code === code); },

  saveProduct(product) {
    const products = this.getProducts();
    const idx = products.findIndex(p => p.id === product.id);
    if (idx >= 0) products[idx] = product;
    else {
      product.code = product.code || this._productCode();
      product.id = product.id || this._uuid();
      products.push(product);
    }
    this.set(this.KEYS.PRODUCTS, products);
    return product;
  },

  deleteProduct(id) {
    const products = this.getProducts().filter(p => p.id !== id);
    this.set(this.KEYS.PRODUCTS, products);
  },

  /* Returns updated product or { error, available } if stock would go negative */
  updateProductQuantity(productId, delta) {
    const products = this.getProducts();
    const idx = products.findIndex(p => p.id === productId);
    if (idx < 0) return null;
    const current = products[idx].quantity || 0;
    const newQty = current + delta;
    if (newQty < 0) {
      return { error: 'Estoque insuficiente', available: current };
    }
    products[idx].quantity = newQty;
    this.set(this.KEYS.PRODUCTS, products);
    return products[idx];
  },

  /* ---------- ENTRIES ---------- */
  getEntries() { return this.get(this.KEYS.ENTRIES) || []; },

  addEntry(entry) {
    const entries = this.getEntries();
    entry.id = this._uuid();
    entry.createdAt = new Date().toISOString();
    entries.unshift(entry);
    this.set(this.KEYS.ENTRIES, entries);
    this.updateProductQuantity(entry.productId, entry.quantity);
    this.addMovement({
      productId: entry.productId,
      productCode: entry.productCode,
      productName: entry.productName,
      type: 'entrada',
      quantity: entry.quantity,
      date: entry.date,
      userId: entry.userId,
      userName: entry.userName,
      observation: entry.observation,
      reference: entry.id,
    });
    return entry;
  },

  /* ---------- EXITS ---------- */
  getExits() { return this.get(this.KEYS.EXITS) || []; },

  /* Returns exit object or { error, available } if stock is insufficient */
  addExit(exit) {
    const result = this.updateProductQuantity(exit.productId, -exit.quantity);
    if (result && result.error) {
      return result;
    }

    const exits = this.getExits();
    exit.id = this._uuid();
    exit.createdAt = new Date().toISOString();
    exits.unshift(exit);
    this.set(this.KEYS.EXITS, exits);

    const product = this.getProduct(exit.productId);
    this.addMovement({
      productId: exit.productId,
      productCode: exit.productCode,
      productName: exit.productName,
      type: 'saida',
      quantity: exit.quantity,
      date: exit.date,
      userId: exit.userId,
      userName: exit.userName,
      observation: exit.observation || exit.destination,
      reference: exit.id,
      balance: product ? product.quantity : 0,
    });
    return exit;
  },

  /* ---------- REQUISITIONS ---------- */
  getRequisitions() { return this.get(this.KEYS.REQUISITIONS) || []; },
  getRequisition(id) { return this.getRequisitions().find(r => r.id === id); },
  getRequisitionByCode(code) { return this.getRequisitions().find(r => r.code === code); },

  saveRequisition(req) {
    const reqs = this.getRequisitions();
    const idx = reqs.findIndex(r => r.id === req.id);
    if (idx >= 0) reqs[idx] = req;
    else reqs.unshift(req);
    this.set(this.KEYS.REQUISITIONS, reqs);
    return req;
  },

  createRequisition(req) {
    req.id = this._uuid();
    req.code = this._reqCode();
    req.createdAt = new Date().toISOString();
    req.status = 'pendente';
    req.items = req.items.map(item => ({ ...item, separated: false, delivered: false }));
    return this.saveRequisition(req);
  },

  /* ---------- TOOLS ---------- */
  getTools() { return this.get(this.KEYS.TOOLS) || []; },
  getTool(id) { return this.getTools().find(t => t.id === id); },

  saveTool(tool) {
    const tools = this.getTools();
    const idx = tools.findIndex(t => t.id === tool.id);
    if (idx >= 0) tools[idx] = tool;
    else {
      tool.id = this._uuid();
      tool.code = this._toolCode();
      tools.push(tool);
    }
    this.set(this.KEYS.TOOLS, tools);
    return tool;
  },

  deleteTool(id) {
    const tools = this.getTools().filter(t => t.id !== id);
    this.set(this.KEYS.TOOLS, tools);
  },

  /* ---------- MOVEMENTS ---------- */
  getMovements() { return this.get(this.KEYS.MOVEMENTS) || []; },

  addMovement(mov) {
    const movements = this.getMovements();
    mov.id = this._uuid();
    mov.createdAt = new Date().toISOString();
    if (mov.balance === undefined) {
      const product = this.getProduct(mov.productId);
      mov.balance = product ? product.quantity : 0;
    }
    movements.unshift(mov);
    if (movements.length > 5000) movements.splice(5000);
    this.set(this.KEYS.MOVEMENTS, movements);
    return mov;
  },

  /* ---------- LOGS ---------- */
  getLogs() { return this.get(this.KEYS.LOGS) || []; },

  addLog(level, userId, userName, action) {
    const logs = this.getLogs();
    logs.unshift({
      id: this._uuid(),
      level,
      userId,
      userName,
      action,
      createdAt: new Date().toISOString(),
    });
    if (logs.length > 10000) logs.splice(10000);
    this.set(this.KEYS.LOGS, logs);
  },

  /* ---------- BACKUPS ---------- */
  /* Backups store metadata only — data is never stored in localStorage.
     Manual backups trigger an immediate file download.
     Auto-backups only update the lastBackup timestamp. */
  getBackups() { return this.get(this.KEYS.BACKUPS) || []; },

  _buildBackupData() {
    return {
      version: 1,
      exportDate: new Date().toISOString(),
      users: this.getUsers(),
      products: this.getProducts(),
      entries: this.getEntries(),
      exits: this.getExits(),
      requisitions: this.getRequisitions(),
      tools: this.getTools(),
      movements: this.getMovements(),
      logs: this.getLogs(),
      settings: this.getSettings(),
    };
  },

  /* Returns { backup (metadata), json (file content) }
     Caller is responsible for downloading the json. */
  createBackup(triggeredBy) {
    const data = this._buildBackupData();
    const json = JSON.stringify(data);

    const backup = {
      id: this._uuid(),
      createdAt: new Date().toISOString(),
      triggeredBy: triggeredBy || 'auto',
      size: json.length,
      records: {
        users: data.users.length,
        products: data.products.length,
        movements: data.movements.length,
        requisitions: data.requisitions.length,
      },
      /* No `data` field — never stored in localStorage */
    };

    const backups = this.getBackups();
    backups.unshift(backup);
    if (backups.length > 20) backups.splice(20);
    this.set(this.KEYS.BACKUPS, backups);

    const settings = this.getSettings();
    settings.lastBackup = backup.createdAt;
    this.set(this.KEYS.SETTINGS, settings);

    return { backup, json };
  },

  deleteBackup(id) {
    const backups = this.getBackups().filter(b => b.id !== id);
    this.set(this.KEYS.BACKUPS, backups);
  },

  /* ---------- SETTINGS ---------- */
  getSettings() { return this.get(this.KEYS.SETTINGS) || {}; },

  /* ---------- LOGIN ATTEMPTS ---------- */
  getAttempts(email) {
    const attempts = this.get(this.KEYS.LOGIN_ATTEMPTS) || {};
    return attempts[email] || { count: 0, lockedUntil: null };
  },

  incrementAttempts(email) {
    const attempts = this.get(this.KEYS.LOGIN_ATTEMPTS) || {};
    const current = attempts[email] || { count: 0, lockedUntil: null };
    current.count++;
    if (current.count >= 5) {
      current.lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    }
    attempts[email] = current;
    this.set(this.KEYS.LOGIN_ATTEMPTS, attempts);
    return current;
  },

  resetAttempts(email) {
    const attempts = this.get(this.KEYS.LOGIN_ATTEMPTS) || {};
    delete attempts[email];
    this.set(this.KEYS.LOGIN_ATTEMPTS, attempts);
  },

  isLocked(email) {
    const a = this.getAttempts(email);
    if (!a.lockedUntil) return false;
    if (new Date() < new Date(a.lockedUntil)) return a.lockedUntil;
    this.resetAttempts(email);
    return false;
  },

  /* ---------- AUTO BACKUP ---------- */
  /* Single interval per page load — checks timestamp to avoid duplicate writes
     across multiple open tabs. */
  _scheduleAutoBackup() {
    const CHECK_INTERVAL = 60 * 1000; /* Check every 60 s */
    setInterval(() => {
      const settings = this.getSettings();
      const intervalMs = (settings.backupInterval || 30) * 60 * 1000;
      const lastBackup = settings.lastBackup ? new Date(settings.lastBackup).getTime() : 0;
      if (Date.now() - lastBackup >= intervalMs) {
        /* Only update timestamp — no file written for silent auto-backups */
        settings.lastBackup = new Date().toISOString();
        this.set(this.KEYS.SETTINGS, settings);
        this.addLog('INFO', 'sistema', 'Sistema', 'Checkpoint de backup automático registrado');
      }
    }, CHECK_INTERVAL);
  },

  /* ---------- PASSWORD HASHING (PBKDF2 + salt) ---------- */
  _genSalt() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr));
  },

  async _pbkdf2(password, salt) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
      key,
      256
    );
    return btoa(String.fromCharCode(...new Uint8Array(bits)));
  },

  async hashPassword(password) {
    const salt = this._genSalt();
    const hash = await this._pbkdf2(password, salt);
    return `pbkdf2:${salt}:${hash}`;
  },

  async verifyPassword(password, storedValue) {
    if (!storedValue) return false;
    if (storedValue.startsWith('pbkdf2:')) {
      /* Modern format: pbkdf2:<salt>:<hash> */
      const colonIdx = storedValue.indexOf(':', 7); /* skip 'pbkdf2:' */
      const salt = storedValue.substring(7, colonIdx);
      const storedHash = storedValue.substring(colonIdx + 1);
      const computed = await this._pbkdf2(password, salt);
      return computed === storedHash;
    }
    /* Legacy djb2 format — accepted for backward compatibility only.
       Password is automatically upgraded to PBKDF2 on next login via auth.js. */
    return storedValue === this._legacyHash(password);
  },

  _legacyHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return 'h' + Math.abs(hash).toString(36) + str.length;
  },

  /* ---------- HELPERS ---------- */
  _uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  },

  /* Persistent sequential counters — never decrement, survive deletions */
  _nextCounter(field) {
    const settings = this.getSettings();
    if (!settings.counters) settings.counters = { product: 0, req: 0, tool: 0 };
    settings.counters[field] = (settings.counters[field] || 0) + 1;
    this.set(this.KEYS.SETTINGS, settings);
    return settings.counters[field];
  },

  _productCode() {
    return `PRD-${String(this._nextCounter('product')).padStart(4, '0')}`;
  },

  _reqCode() {
    return `REQ-${String(this._nextCounter('req')).padStart(4, '0')}`;
  },

  _toolCode() {
    return `FER-${String(this._nextCounter('tool')).padStart(3, '0')}`;
  },

  /* ---------- STATS ---------- */
  getStats() {
    const products = this.getProducts();
    const movements = this.getMovements();
    const requisitions = this.getRequisitions();
    const tools = this.getTools();

    return {
      totalProducts: products.length,
      totalStock: products.reduce((s, p) => s + (p.quantity || 0), 0),
      lowStock: products.filter(p => p.quantity <= p.minStock).length,
      pendingRequisitions: requisitions.filter(r => r.status === 'pendente').length,
      toolsBorrowed: tools.filter(t => t.status === 'emprestado').length,
      recentMovements: movements.slice(0, 10),
      movementsToday: movements.filter(m => {
        return new Date(m.createdAt).toDateString() === new Date().toDateString();
      }).length,
    };
  },

  /* ---------- EXPORT ---------- */
  exportJSON() {
    return JSON.stringify(this._buildBackupData(), null, 2);
  },

  exportCSV(type) {
    const escape = v => `"${String(v || '').replace(/"/g, '""')}"`;
    if (type === 'products') {
      const products = this.getProducts();
      const header = ['Código','Nome','Categoria','Descrição','Quantidade','Unidade','Estoque Mínimo','Localização'];
      const rows = products.map(p => [
        p.code, p.name, p.category, p.description, p.quantity, p.unit, p.minStock,
        p.location ? `${p.location.corridor}-${p.location.shelf}-${p.location.rack}-${p.location.position}` : '',
      ].map(escape).join(','));
      return [header.join(','), ...rows].join('\n');
    }
    if (type === 'movements') {
      const movements = this.getMovements();
      const header = ['Produto','Código','Tipo','Quantidade','Saldo','Data','Usuário','Observação'];
      const rows = movements.map(m => [
        m.productName, m.productCode, m.type, m.quantity, m.balance,
        this.formatDate(m.date || m.createdAt), m.userName, m.observation,
      ].map(escape).join(','));
      return [header.join(','), ...rows].join('\n');
    }
    if (type === 'requisitions') {
      const reqs = this.getRequisitions();
      const header = ['Código','Solicitante','Setor','Data','Status','Itens','Observação'];
      const rows = reqs.map(r => [
        r.code, r.requesterName, r.sector, this.formatDate(r.createdAt),
        r.status, r.items ? r.items.length : 0, r.observation,
      ].map(escape).join(','));
      return [header.join(','), ...rows].join('\n');
    }
    return '';
  },

  formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      return new Date(dateStr).toLocaleString('pt-BR');
    } catch { return dateStr; }
  },
};
