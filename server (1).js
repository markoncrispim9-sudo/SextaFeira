require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // ex: https://seu-app.onrender.com/auth/google/callback
const APP_KEY = process.env.APP_KEY; // senha simples que só o seu app conhece
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN; // preenchido depois do primeiro login

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

if (REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly'
];

// Passo de login: abre a tela de autorização do Google
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
  res.redirect(url);
});

// O Google volta pra cá depois que você autoriza
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Faltou o código de autorização.');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    res.send(`
      <div style="font-family: sans-serif; max-width: 600px; margin: 40px auto;">
        <h2>Conectado com sucesso!</h2>
        <p>Copie o valor abaixo e cole como variável de ambiente <b>GOOGLE_REFRESH_TOKEN</b> no Render. Depois reinicie o serviço.</p>
        <textarea style="width:100%;height:90px;font-size:13px;">${tokens.refresh_token || '(nenhum refresh_token veio — vá em myaccount.google.com/permissions, remova o acesso deste app e tente de novo)'}</textarea>
      </div>
    `);
  } catch (err) {
    res.status(500).send('Erro ao trocar código por token: ' + err.message);
  }
});

function checkAppKey(req, res, next) {
  if (!APP_KEY || req.headers['x-app-key'] === APP_KEY) return next();
  return res.status(401).json({ error: 'chave inválida' });
}

// Eventos de hoje no Google Calendar
app.get('/api/calendar/today', checkAppKey, async (req, res) => {
  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
    const result = await calendar.events.list({
      calendarId: 'primary',
      timeMin: start,
      timeMax: end,
      singleEvents: true,
      orderBy: 'startTime'
    });
    const events = (result.data.items || []).map(e => ({
      title: e.summary || '(sem título)',
      time: e.start.dateTime ? new Date(e.start.dateTime).toTimeString().slice(0, 5) : 'dia todo'
    }));
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Últimos e-mails da caixa de entrada
app.get('/api/gmail/recent', checkAppKey, async (req, res) => {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: 8, q: 'in:inbox' });
    const messages = await Promise.all((list.data.messages || []).map(async m => {
      const msg = await gmail.users.messages.get({
        userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject']
      });
      const headers = msg.data.payload.headers;
      const from = (headers.find(h => h.name === 'From') || {}).value || '';
      const subject = (headers.find(h => h.name === 'Subject') || {}).value || '(sem assunto)';
      return { from, subject, snippet: msg.data.snippet };
    }));
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Servidor do assistente pessoal está no ar.'));

app.listen(PORT, () => console.log('Rodando na porta ' + PORT));
