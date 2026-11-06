const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
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

// Estado global da conexão
let sock = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR_READY, CONNECTED
let qrCodeDataUrl = null;
let connectedUser = null;

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

async function iniciarWhatsApp() {
  connectionStatus = 'CONNECTING';
  console.log('[WhatsApp] Iniciando conexão Baileys...');

  try {
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

    sock.ev.on('creds.update', saveCreds);

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
    qr: qrCodeDataUrl
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

  // Se o número brasileiro não tiver 55 no início, adiciona
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
    console.error(`[WhatsApp] Erro ao checar ${cleanPhone}:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro ao consultar WhatsApp'
    });
  }
});

// 4. Validação em Lote (Bulk)
app.post('/api/check-bulk', async (req, res) => {
  const { phones } = req.body;

  if (!phones || !Array.isArray(phones)) {
    return res.status(400).json({ error: 'Envie um array de telefones no corpo da requisição: { phones: ["5511..."] }' });
  }

  if (connectionStatus !== 'CONNECTED' || !sock) {
    return res.status(503).json({ error: 'WhatsApp não está conectado' });
  }

  const results = [];
  for (const phone of phones.slice(0, 50)) { // Limite seguro de 50 por lote
    let clean = String(phone).replace(/\D/g, '');
    if (clean.length === 10 || clean.length === 11) clean = '55' + clean;
    try {
      const resWpp = await sock.onWhatsApp(`${clean}@s.whatsapp.net`);
      const exists = !!(resWpp && resWpp.length > 0 && resWpp[0].exists);
      results.push({ phone: clean, exists, jid: exists ? resWpp[0].jid : null });
    } catch (e) {
      results.push({ phone: clean, exists: false, error: e.message });
    }
  }

  res.json({ success: true, count: results.length, results });
});

// 5. Logout para trocar de chip
app.post('/api/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectionStatus = 'DISCONNECTED';
    connectedUser = null;
    qrCodeDataUrl = null;
    setTimeout(iniciarWhatsApp, 1500);
    res.json({ success: true, message: 'Desconectado com sucesso. Novo QR Code será gerado.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PAINEL VISUAL WEB (HTML)
// ==========================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Validador WhatsApp Cloud</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0d1117;
      color: #f0f6fc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 14px;
      width: 100%;
      max-width: 480px;
      padding: 28px;
      box-shadow: 0 16px 36px rgba(0,0,0,0.4);
      text-align: center;
    }
    .title {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    .subtitle {
      font-size: 13px;
      color: #8b949e;
      margin-bottom: 22px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 20px;
    }
    .badge-connected { background: rgba(35, 134, 54, 0.2); color: #3fb950; border: 1px solid rgba(63, 185, 80, 0.4); }
    .badge-waiting { background: rgba(210, 153, 34, 0.2); color: #d29922; border: 1px solid rgba(210, 153, 34, 0.4); }
    .badge-disconnected { background: rgba(248, 81, 73, 0.2); color: #f85149; border: 1px solid rgba(248, 81, 73, 0.4); }
    
    .qr-box {
      background: #ffffff;
      padding: 14px;
      border-radius: 12px;
      display: inline-block;
      margin-bottom: 16px;
      min-width: 280px;
      min-height: 280px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .qr-box img {
      width: 260px;
      height: 260px;
      display: block;
    }
    .instructions {
      font-size: 13px;
      color: #8b949e;
      line-height: 1.5;
      margin-bottom: 20px;
    }
    .test-box {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 10px;
      padding: 16px;
      margin-top: 14px;
      text-align: left;
    }
    .test-box label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: #8b949e;
      margin-bottom: 6px;
    }
    .input-group {
      display: flex;
      gap: 8px;
    }
    input {
      flex: 1;
      background: #161b22;
      border: 1px solid #30363d;
      color: #f0f6fc;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 14px;
      outline: none;
    }
    input:focus { border-color: #58a6ff; }
    button {
      background: #238636;
      color: #ffffff;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #2ea043; }
    .btn-danger {
      background: transparent;
      color: #f85149;
      border: 1px solid rgba(248,81,73,0.3);
      margin-top: 16px;
      width: 100%;
    }
    .btn-danger:hover { background: rgba(248,81,73,0.1); }
    .result-box {
      margin-top: 10px;
      padding: 10px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      display: none;
    }
    .result-valid { background: rgba(35, 134, 54, 0.2); color: #3fb950; border: 1px solid rgba(63, 185, 80, 0.4); }
    .result-invalid { background: rgba(248, 81, 73, 0.2); color: #f85149; border: 1px solid rgba(248, 81, 73, 0.4); }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">
      <span>⚡ Validador de WhatsApp</span>
    </div>
    <div class="subtitle">API de Consulta em Nuvem 24/7</div>

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
      <p style="font-size: 13px; color: #8b949e; margin-bottom: 16px;">Pronto para validar leads em tempo real.</p>
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
          
          // Puxa a imagem do QR
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

    // Polling a cada 3 segundos
    setInterval(atualizarStatus, 3000);
    atualizarStatus();
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(`[Servidor] Validador rodando com sucesso na porta ${PORT}`);
});
