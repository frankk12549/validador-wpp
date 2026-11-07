const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const https = require('https');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Configurações do Supabase para persistência permanente da sessão
const SUPABASE_URL = "https://mcyqthnscypindrchdke.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jeXF0aG5zY3lwaW5kcmNoZGtlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5NzA2MzgsImV4cCI6MjA5OTU0NjYzOH0.y7HeOyzG0Dbt833Kvcs7ahhn-wnT79AEUzS3GVUBaTs";

// Estado global da conexão
let sock = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR_READY, CONNECTED
let qrCodeDataUrl = null;
let connectedUser = null;

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

// ==========================================
// PERSISTÊNCIA DA SESSÃO NO SUPABASE (NUNCA DESLOGA)
// ==========================================

async function restaurarSessaoSupabase() {
  return new Promise((resolve) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/leads_painel?produto=eq.__AUTH_SESSION__&select=payload_bruto`);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const rows = JSON.parse(body || '[]');
          if (rows.length > 0 && rows[0].payload_bruto && Object.keys(rows[0].payload_bruto).length > 0) {
            const files = rows[0].payload_bruto;
            if (!fs.existsSync(AUTH_DIR)) {
              fs.mkdirSync(AUTH_DIR, { recursive: true });
            }
            for (const [filename, content] of Object.entries(files)) {
              fs.writeFileSync(path.join(AUTH_DIR, filename), content, 'utf8');
            }
            console.log('[Supabase] ✅ Sessão do WhatsApp restaurada com sucesso!');
            return resolve(true);
          }
        } catch (e) {
          console.error('[Supabase] Erro ao restaurar sessão:', e);
        }
        resolve(false);
      });
    });

    req.on('error', () => resolve(false));
    req.end();
  });
}

let saveTimeout = null;
function salvarSessaoSupabase() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      if (!fs.existsSync(AUTH_DIR)) return;
      const fileNames = fs.readdirSync(AUTH_DIR);
      const sessionData = {};
      for (const name of fileNames) {
        const fullPath = path.join(AUTH_DIR, name);
        if (fs.statSync(fullPath).isFile()) {
          sessionData[name] = fs.readFileSync(fullPath, 'utf8');
        }
      }

      if (Object.keys(sessionData).length === 0) return;

      // Checa se já existe registro
      const checkRes = await new Promise(res => {
        https.get(`${SUPABASE_URL}/rest/v1/leads_painel?produto=eq.__AUTH_SESSION__&select=id`, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        }, r => {
          let d = '';
          r.on('data', chunk => d += chunk);
          r.on('end', () => {
            try { res(JSON.parse(d || '[]')); } catch(e) { res([]); }
          });
        }).on('error', () => res([]));
      });

      if (checkRes.length > 0) {
        const patchData = JSON.stringify({ payload_bruto: sessionData });
        const req = https.request(`${SUPABASE_URL}/rest/v1/leads_painel?produto=eq.__AUTH_SESSION__`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Length': Buffer.byteLength(patchData)
          }
        });
        req.write(patchData);
        req.end();
      } else {
        const postData = JSON.stringify({
          nome: 'BAILEYS_AUTH',
          telefone: '00000000000',
          produto: '__AUTH_SESSION__',
          status_atendimento: 'sistema',
          payload_bruto: sessionData
        });
        const req = https.request(`${SUPABASE_URL}/rest/v1/leads_painel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Length': Buffer.byteLength(postData)
          }
        });
        req.write(postData);
        req.end();
      }
      console.log('[Supabase] 💾 Sessão do WhatsApp salva na nuvem!');
    } catch (e) {
      console.error('[Supabase] Erro ao salvar sessão:', e);
    }
  }, 2500);
}

async function limparSessaoSupabase() {
  try {
    const patchData = JSON.stringify({ payload_bruto: {} });
    const req = https.request(`${SUPABASE_URL}/rest/v1/leads_painel?produto=eq.__AUTH_SESSION__`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Length': Buffer.byteLength(patchData)
      }
    });
    req.write(patchData);
    req.end();
    console.log('[Supabase] 🗑️ Sessão limpa do Supabase.');
  } catch(e) {
    console.error('[Supabase] Erro ao limpar sessão:', e);
  }
}

// ==========================================
// INICIALIZAÇÃO BAILEYS
// ==========================================

async function iniciarWhatsApp() {
  connectionStatus = 'CONNECTING';
  console.log('[WhatsApp] Iniciando conexão Baileys...');

  try {
    // 1. Restaura credenciais salvas do Supabase caso o Render tenha reiniciado
    await restaurarSessaoSupabase();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WhatsApp] Usando versão do Baileys: ${version.join('.')} (Última: ${isLatest})`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      auth: state,
      browser: ['Validador Cloud', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000
    });

    sock.ev.on('creds.update', () => {
      saveCreds();
      salvarSessaoSupabase();
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[WhatsApp] Novo QR Code gerado.');
        connectionStatus = 'QR_READY';
        try {
          qrCodeDataUrl = await qrcode.toDataURL(qr, { width: 320, margin: 2 });
        } catch (err) {
          console.error('[WhatsApp] Erro ao renderizar QR:', err);
        }
      }

      if (connection === 'open') {
        connectionStatus = 'CONNECTED';
        qrCodeDataUrl = null;
        connectedUser = (sock.user && sock.user.id) ? sock.user.id.split(':')[0] : 'Conectado';
        console.log(`[WhatsApp] Conectado com sucesso como: ${connectedUser}`);
        salvarSessaoSupabase();
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[WhatsApp] Conexão fechada. Motivo / Código: ${statusCode}`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('[WhatsApp] Desconectado permanentemente (Logout). Limpando sessão...');
          connectionStatus = 'DISCONNECTED';
          qrCodeDataUrl = null;
          connectedUser = null;
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
          await limparSessaoSupabase();
          setTimeout(iniciarWhatsApp, 2000);
        } else {
          console.log('[WhatsApp] Tentando reconectar em 3 segundos...');
          connectionStatus = 'CONNECTING';
          setTimeout(iniciarWhatsApp, 3000);
        }
      }
    });

  } catch (error) {
    console.error('[WhatsApp] Erro ao iniciar:', error);
    connectionStatus = 'DISCONNECTED';
    setTimeout(iniciarWhatsApp, 5000);
  }
}

// Inicia Baileys no boot
iniciarWhatsApp();

// Auto-ping a cada 10 minutos para manter o Render acordado 24/7
setInterval(() => {
  https.get('https://validador-wpp.onrender.com/api/status', () => {}).on('error', () => {});
}, 10 * 60 * 1000);

// ==========================================
// ROTAS DA API
// ==========================================

// 1. Status da Conexão
app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    user: connectedUser,
    timestamp: new Date().toISOString()
  });
});

// 2. QR Code Atual
app.get('/api/qr', (req, res) => {
  res.json({
    status: connectionStatus,
    qr: qrCodeDataUrl,
    user: connectedUser
  });
});

// 3. Validação Individual de Telefone
app.get('/api/check', async (req, res) => {
  const { phone } = req.query;

  if (!phone) {
    return res.status(400).json({ error: 'Parâmetro phone é obrigatório (ex: /api/check?phone=5511999998888)' });
  }

  if (connectionStatus !== 'CONNECTED' || !sock) {
    return res.status(503).json({
      error: 'WhatsApp ainda não está conectado na nuvem. Acesse a página inicial para escanear o QR Code.',
      status: connectionStatus
    });
  }

  // Sanitiza número: remove tudo que não for dígito
  let cleanPhone = String(phone).replace(/\D/g, '');

  if (cleanPhone.length === 10 || cleanPhone.length === 11) {
    cleanPhone = '55' + cleanPhone;
  }

  const targetJid = `${cleanPhone}@s.whatsapp.net`;

  try {
    const result = await sock.onWhatsApp(targetJid);

    if (result && result.length > 0 && result[0].exists) {
      return res.json({
        success: true,
        exists: true,
        phone: cleanPhone,
        jid: result[0].jid
      });
    } else {
      return res.json({
        success: true,
        exists: false,
        phone: cleanPhone,
        jid: null
      });
    }
  } catch (error) {
    console.error(`[WhatsApp] Erro ao validar número ${cleanPhone}:`, error);
    return res.status(500).json({
      error: 'Erro interno ao validar número no WhatsApp',
      details: error.message
    });
  }
});

// 4. Validação em Lote (Bulk)
app.post('/api/check-bulk', async (req, res) => {
  const { phones } = req.body;

  if (!phones || !Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: 'Envie um array de telefones no corpo: { phones: ["5511999998888", ...] }' });
  }

  if (connectionStatus !== 'CONNECTED' || !sock) {
    return res.status(503).json({
      error: 'WhatsApp desconectado. Conecte primeiro via QR Code.',
      status: connectionStatus
    });
  }

  const results = [];

  for (const phone of phones) {
    let clean = String(phone).replace(/\D/g, '');
    if (clean.length === 10 || clean.length === 11) clean = '55' + clean;
    if (!clean) continue;

    try {
      const resWpp = await sock.onWhatsApp(`${clean}@s.whatsapp.net`);
      const exists = (resWpp && resWpp.length > 0 && resWpp[0].exists) ? true : false;
      results.push({
        phone: clean,
        exists,
        jid: exists ? resWpp[0].jid : null
      });
      // Pequeno delay para segurança
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      results.push({ phone: clean, exists: false, error: e.message });
    }
  }

  res.json({
    total: results.length,
    valid: results.filter(r => r.exists).length,
    invalid: results.filter(r => !r.exists).length,
    results
  });
});

// 5. Desconectar / Trocar de Chip
app.post('/api/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
      sock.end();
      sock = null;
    }
    connectionStatus = 'DISCONNECTED';
    connectedUser = null;
    qrCodeDataUrl = null;
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch (e) {}
    await limparSessaoSupabase();
    setTimeout(iniciarWhatsApp, 1500);
    res.json({ success: true, message: 'WhatsApp desconectado com sucesso. Novo QR Code será gerado.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Interface Visual Dark Mode
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Validador de WhatsApp - Nuvem</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background-color: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background-color: #161b22; border: 1px solid #30363d; border-radius: 12px; width: 100%; max-width: 480px; padding: 32px 24px; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    .title { font-size: 22px; font-weight: 700; color: #f0f6fc; margin-bottom: 8px; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .subtitle { font-size: 13px; color: #8b949e; margin-bottom: 24px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; margin-bottom: 24px; }
    .badge-connected { background-color: rgba(35, 134, 54, 0.2); color: #3fb950; border: 1px solid rgba(56, 139, 253, 0.1); }
    .badge-waiting { background-color: rgba(210, 153, 34, 0.2); color: #d29922; }
    .badge-disconnected { background-color: rgba(248, 81, 73, 0.2); color: #f85149; }
    .qr-box { background: white; padding: 12px; border-radius: 8px; display: inline-block; margin-bottom: 16px; }
    .qr-box img { display: block; max-width: 100%; height: auto; }
    .instructions { font-size: 13px; color: #8b949e; line-height: 1.5; margin-bottom: 24px; }
    .test-box { background-color: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-top: 20px; text-align: left; }
    .test-box label { font-size: 12px; font-weight: 600; color: #8b949e; display: block; margin-bottom: 8px; }
    .input-group { display: flex; gap: 8px; }
    .input-group input { flex: 1; background: #161b22; border: 1px solid #30363d; color: #fff; padding: 10px 12px; border-radius: 6px; font-size: 14px; }
    .input-group input:focus { outline: none; border-color: #238636; }
    .input-group button { background: #238636; color: white; border: none; padding: 10px 16px; border-radius: 6px; font-weight: 600; cursor: pointer; transition: 0.2s; }
    .input-group button:hover { background: #2ea043; }
    .result-box { margin-top: 12px; font-size: 13px; padding: 10px; border-radius: 6px; display: none; }
    .result-valid { background: rgba(35, 134, 54, 0.2); color: #3fb950; border: 1px solid #238636; }
    .result-invalid { background: rgba(248, 81, 73, 0.2); color: #f85149; border: 1px solid #da3633; }
    .btn-danger { background: #da3633; color: white; border: none; padding: 8px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; margin-top: 16px; }
    .btn-danger:hover { background: #b62324; }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">
      <span>⚡ Validador de WhatsApp</span>
    </div>
    <div class="subtitle">API de Consulta em Nuvem 24/7 (Sessão Permanente Supabase)</div>

    <div id="badge-status" class="badge badge-waiting">
      <span id="badge-dot">●</span> <span id="badge-text">Carregando status...</span>
    </div>

    <!-- BOX DO QR CODE -->
    <div id="qr-container" style="display: none;">
      <div class="qr-box">
        <img id="qr-img" src="" alt="QR Code WhatsApp">
      </div>
      <div class="instructions">
        Abra o WhatsApp no celular > <strong>Aparelhos conectados</strong> > <strong>Conectar um aparelho</strong> e aponte para a tela.
      </div>
    </div>

    <!-- BOX DE SUCESSO / CONECTADO -->
    <div id="connected-box" style="display: none;">
      <div style="font-size: 48px; margin-bottom: 12px;">✅</div>
      <div style="font-weight: 700; font-size: 16px; color: #3fb950; margin-bottom: 4px;">WhatsApp Conectado!</div>
      <p style="font-size: 13px; color: #8b949e; margin-bottom: 16px;">Sessão salva na nuvem. Pronto para validar leads.</p>
    </div>

    <!-- BOX DE TESTE DE NÚMERO -->
    <div class="test-box">
      <label>🧪 Testar um número agora:</label>
      <div class="input-group">
        <input type="text" id="test-phone" placeholder="Ex: 5511999998888">
        <button onclick="testarNumero()">Validar</button>
      </div>
      <div id="test-result" class="result-box"></div>
    </div>

    <button id="btn-logout" class="btn-danger" style="display: none;" onclick="desconectar()">Desconectar Chip</button>
  </div>

  <script>
    async function atualizarStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        const badge = document.getElementById('badge-status');
        const badgeText = document.getElementById('badge-text');
        const qrContainer = document.getElementById('qr-container');
        const connectedBox = document.getElementById('connected-box');
        const btnLogout = document.getElementById('btn-logout');

        badge.className = 'badge';

        if (data.status === 'CONNECTED') {
          badge.classList.add('badge-connected');
          badgeText.innerText = 'Online (' + (data.user || 'Conectado') + ')';
          qrContainer.style.display = 'none';
          connectedBox.style.display = 'block';
          btnLogout.style.display = 'block';
        } else if (data.status === 'QR_READY') {
          badge.classList.add('badge-waiting');
          badgeText.innerText = 'Aguardando Leitura do QR Code';
          connectedBox.style.display = 'none';
          btnLogout.style.display = 'none';
          
          const qrRes = await fetch('/api/qr');
          const qrData = await qrRes.json();
          if (qrData.qr) {
            document.getElementById('qr-img').src = qrData.qr;
            qrContainer.style.display = 'block';
          }
        } else {
          badge.classList.add('badge-disconnected');
          badgeText.innerText = 'Iniciando conexão...';
          connectedBox.style.display = 'none';
          qrContainer.style.display = 'none';
          btnLogout.style.display = 'none';
        }
      } catch (err) {
        console.error('Erro ao buscar status:', err);
      }
    }

    async function testarNumero() {
      const input = document.getElementById('test-phone');
      const box = document.getElementById('test-result');
      const phone = input.value.trim();
      
      if (!phone) return;
      box.style.display = 'block';
      box.className = 'result-box';
      box.innerText = 'Consultando servidores do WhatsApp...';

      try {
        const res = await fetch('/api/check?phone=' + encodeURIComponent(phone));
        const data = await res.json();

        if (data.exists) {
          box.className = 'result-box result-valid';
          box.innerText = '✅ TEM WhatsApp ativo! (' + data.phone + ')';
        } else {
          box.className = 'result-box result-invalid';
          box.innerText = '❌ NÃO tem WhatsApp registrado.';
        }
      } catch (e) {
        box.className = 'result-box result-invalid';
        box.innerText = 'Erro ao consultar: ' + e.message;
      }
    }

    async function desconectar() {
      if (!confirm('Deseja realmente desconectar este WhatsApp?')) return;
      try {
        await fetch('/api/logout', { method: 'POST' });
        atualizarStatus();
      } catch (e) {
        alert('Erro ao desconectar: ' + e.message);
      }
    }

    setInterval(atualizarStatus, 3000);
    atualizarStatus();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`[Servidor] Validador rodando com sucesso na porta ${PORT}`);
});
