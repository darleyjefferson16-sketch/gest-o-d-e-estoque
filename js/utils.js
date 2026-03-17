/* =====================================================
   UTILS.JS - Utilitários (QR Code, Export, Backup)
   ===================================================== */

const Utils = {

  /* ---------- QR CODE GENERATION ---------- */
  generateQR(containerId, text, size = 128) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    if (typeof QRCode !== 'undefined') {
      new QRCode(container, {
        text: String(text),
        width: size,
        height: size,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
      });
    } else {
      container.innerHTML = `<div style="width:${size}px;height:${size}px;background:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;color:#000;padding:8px;text-align:center;border-radius:4px;">${text}</div>`;
    }
  },

  getQRDataUrl(text, size = 128) {
    return new Promise((resolve) => {
      const div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.left = '-9999px';
      document.body.appendChild(div);
      if (typeof QRCode !== 'undefined') {
        const qr = new QRCode(div, {
          text: String(text),
          width: size,
          height: size,
          colorDark: '#000000',
          colorLight: '#ffffff',
        });
        setTimeout(() => {
          const canvas = div.querySelector('canvas');
          const img = div.querySelector('img');
          const dataUrl = canvas ? canvas.toDataURL() : (img ? img.src : '');
          document.body.removeChild(div);
          resolve(dataUrl);
        }, 200);
      } else {
        document.body.removeChild(div);
        resolve('');
      }
    });
  },

  /* ---------- DATE HELPERS ---------- */
  formatDate(dateStr) {
    if (!dateStr) return '-';
    try {
      return new Date(dateStr).toLocaleDateString('pt-BR');
    } catch { return dateStr; }
  },

  formatDateTime(dateStr) {
    if (!dateStr) return '-';
    try {
      return new Date(dateStr).toLocaleString('pt-BR');
    } catch { return dateStr; }
  },

  formatRelative(dateStr) {
    if (!dateStr) return '-';
    const diff = Date.now() - new Date(dateStr).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return 'agora mesmo';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}min atrás`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h atrás`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d} dia(s) atrás`;
    return this.formatDate(dateStr);
  },

  formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  },

  /* ---------- DOWNLOAD ---------- */
  downloadFile(content, filename, type = 'text/plain') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  downloadJSON(data, filename) {
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    this.downloadFile(content, filename, 'application/json');
  },

  downloadCSV(content, filename) {
    const bom = '\uFEFF';
    this.downloadFile(bom + content, filename, 'text/csv;charset=utf-8;');
  },

  downloadExcel(data, headers, filename) {
    if (typeof XLSX !== 'undefined') {
      const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Dados');
      XLSX.writeFile(wb, filename);
    } else {
      /* Fallback: CSV */
      const csv = [headers, ...data].map(row => row.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')).join('\n');
      this.downloadCSV(csv, filename.replace('.xlsx', '.csv'));
    }
  },

  /* ---------- IMPORT JSON ---------- */
  importJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          resolve(JSON.parse(e.target.result));
        } catch {
          reject(new Error('Arquivo JSON inválido'));
        }
      };
      reader.onerror = () => reject(new Error('Erro ao ler arquivo'));
      reader.readAsText(file);
    });
  },

  /* ---------- PRINT LABEL ---------- */
  printLabel(product) {
    const win = window.open('', '_blank', 'width=400,height=350');
    Utils.getQRDataUrl(product.code, 120).then(qrUrl => {
      win.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Etiqueta - ${product.code}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 16px; }
            .label { border: 2px solid #000; padding: 16px; text-align: center; max-width: 250px; margin: 0 auto; }
            h2 { font-size: 14px; margin: 0 0 4px; }
            p { font-size: 11px; color: #555; margin: 2px 0; }
            .code { font-family: monospace; font-size: 13px; font-weight: bold; margin: 6px 0; }
            img { margin: 8px 0; }
            @media print { body { padding: 0; } }
          </style>
        </head>
        <body>
          <div class="label">
            <h2>${product.name}</h2>
            <p>${product.category || ''}</p>
            <div class="code">${product.code}</div>
            ${qrUrl ? `<img src="${qrUrl}" width="120" height="120" alt="QR Code">` : ''}
            <p>${product.unit || ''} | Qtd: ${product.quantity}</p>
            ${product.location ? `<p>Loc: ${product.location.corridor}-${product.location.shelf}-${product.location.rack}-${product.location.position}</p>` : ''}
          </div>
          <script>window.onload = () => { window.print(); window.close(); }<\/script>
        </body>
        </html>
      `);
      win.document.close();
    });
  },

  /* ---------- PRINT MULTIPLE LABELS ---------- */
  printLabels(products) {
    const win = window.open('', '_blank', 'width=800,height=600');
    const labelsHtml = products.map(p => `
      <div class="label">
        <div class="qr" id="qr-${p.code}"></div>
        <h2>${p.name}</h2>
        <div class="code">${p.code}</div>
        <p>${p.category || ''} | ${p.unit || ''}</p>
      </div>
    `).join('');

    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Etiquetas</title>
        <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"><\/script>
        <style>
          body { font-family: Arial, sans-serif; margin: 16px; }
          .labels { display: flex; flex-wrap: wrap; gap: 12px; }
          .label { border: 1px solid #000; padding: 12px; text-align: center; width: 180px; }
          h2 { font-size: 12px; margin: 6px 0 2px; }
          p { font-size: 10px; color: #555; margin: 2px 0; }
          .code { font-family: monospace; font-size: 12px; font-weight: bold; }
          @media print { .no-print { display: none; } }
        </style>
      </head>
      <body>
        <button class="no-print" onclick="window.print()" style="margin-bottom:12px;padding:8px 16px;cursor:pointer;">Imprimir</button>
        <div class="labels">${labelsHtml}</div>
        <script>
          window.onload = () => {
            ${products.map(p => {
              /* JSON.stringify prevents code injection if p.code contains quotes or special chars */
              const safeCode = JSON.stringify(p.code);
              const safeId = JSON.stringify(`qr-${p.code}`);
              return `new QRCode(document.getElementById(${safeId}), {text:${safeCode},width:80,height:80});`;
            }).join('\n')}
          };
        <\/script>
      </body>
      </html>
    `);
    win.document.close();
  },

  /* ---------- SEARCH ---------- */
  globalSearch(query) {
    if (!query || query.length < 2) return [];
    const q = query.toLowerCase();
    const results = [];

    DB.getProducts().forEach(p => {
      if (p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q)) {
        results.push({ type: 'product', icon: 'fa-box', label: p.name, sub: `${p.code} · ${p.category}`, href: 'estoque.html', data: p });
      }
    });

    DB.getRequisitions().forEach(r => {
      if (r.code.toLowerCase().includes(q) || r.requesterName.toLowerCase().includes(q)) {
        results.push({ type: 'requisition', icon: 'fa-clipboard-list', label: r.code, sub: `${r.requesterName} · ${r.status}`, href: 'requisicoes.html', data: r });
      }
    });

    DB.getTools().forEach(t => {
      if (t.name.toLowerCase().includes(q) || (t.code || '').toLowerCase().includes(q)) {
        results.push({ type: 'tool', icon: 'fa-wrench', label: t.name, sub: `${t.code} · ${t.status}`, href: 'ferramentas.html', data: t });
      }
    });

    return results.slice(0, 12);
  },

  /* ---------- STOCK LEVEL ---------- */
  stockLevel(product) {
    if (!product) return 'ok';
    if (product.quantity === 0) return 'critical';
    if (product.quantity <= product.minStock) return 'low';
    return 'ok';
  },

  stockBadge(product) {
    const level = this.stockLevel(product);
    if (level === 'critical') return '<span class="badge badge-danger">Crítico</span>';
    if (level === 'low') return '<span class="badge badge-warning">Baixo</span>';
    return '<span class="badge badge-success">Normal</span>';
  },

  /* ---------- REQUISITION STATUS ---------- */
  reqStatusBadge(status) {
    const map = {
      'pendente': '<span class="badge badge-warning">Pendente</span>',
      'em_atendimento': '<span class="badge badge-primary">Em Atendimento</span>',
      'concluida': '<span class="badge badge-success">Concluída</span>',
      'cancelada': '<span class="badge badge-muted">Cancelada</span>',
    };
    return map[status] || `<span class="badge badge-muted">${status}</span>`;
  },

  /* ---------- ESCAPE HTML ---------- */
  esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
