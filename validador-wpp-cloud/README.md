# ⚡ Validador de WhatsApp Cloud (Baileys)

API em nuvem 100% gratuita para validar se números de telefone possuem WhatsApp ativo.

---

## 🚀 Como subir no Render.com (Passo a Passo)

### 1. Criar Repositório no GitHub
1. Acesse o seu [GitHub](https://github.com/new).
2. Nome do repositório: `validador-wpp` (pode deixar **Público** ou **Privado**).
3. Não precisa marcar README nem .gitignore (já temos aqui).
4. Clique em **"Create repository"**.

### 2. Subir os arquivos para o GitHub
No terminal da pasta deste projeto:
```bash
git init
git add .
git commit -m "Initial commit - Validador WhatsApp"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/validador-wpp.git
git push -u origin main
```

---

### 3. Conectar no Render.com
1. Acesse o painel do [Render Dashboard](https://dashboard.render.com).
2. Clique no botão **"New +"** (no topo) e selecione **"Web Service"**.
3. Escolha **"Build and deploy from a Git repository"** e clique em **Next**.
4. Conecte sua conta do GitHub e selecione o repositório `validador-wpp`.
5. Preencha as configurações:
   * **Name:** `validador-whatsapp` (ou o nome que quiser)
   * **Language:** `Node`
   * **Branch:** `main`
   * **Build Command:** `npm install`
   * **Start Command:** `node index.js`
   * **Instance Type:** `Free` (0 $/month)
6. Clique em **"Create Web Service"** no final da página.

---

### 4. Usar a API
O Render vai gerar um link público para você (ex: `https://validador-whatsapp.onrender.com`).

1. **Escanear o QR Code:**
   * Abra o link no navegador.
   * Aponte o WhatsApp do seu celular em **Aparelhos Conectados** para o QR Code da tela.
   * Assim que conectar, ele fica **Online (Verde)**!

2. **Validar um Número via Link / Painel:**
   * `GET https://validador-whatsapp.onrender.com/api/check?phone=5511999998888`
   * Resposta:
     ```json
     {
       "success": true,
       "exists": true,
       "phone": "5511999998888",
       "jid": "5511999998888@s.whatsapp.net"
     }
     ```
