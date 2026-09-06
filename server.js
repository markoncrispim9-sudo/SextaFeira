require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // ex: https://seu-app.onrender.com/auth/google/callback
const APP_KEY = process.env.APP_KEY; // senha simples que só o seu app conhece
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN; // preenchido depois do primeiro login
const GROQ_API_KEY = process.env.GROQ_API_KEY; // chave gratuita da Groq (console.groq.com)

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const groq = new Groq({ apiKey: GROQ_API_KEY });

if (REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
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

// ---------- Funções auxiliares que buscam dados do Google ----------

async function getTodayEvents() {
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
  return (result.data.items || []).map(e => ({
    title: e.summary || '(sem título)',
    time: e.start.dateTime ? new Date(e.start.dateTime).toTimeString().slice(0, 5) : 'dia todo'
  }));
}

async function getRecentEmails() {
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const list = await gmail.users.messages.list({ userId: 'me', maxResults: 8, q: 'in:inbox' });
  return Promise.all((list.data.messages || []).map(async m => {
    const msg = await gmail.users.messages.get({
      userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject']
    });
    const headers = msg.data.payload.headers;
    const from = (headers.find(h => h.name === 'From') || {}).value || '';
    const subject = (headers.find(h => h.name === 'Subject') || {}).value || '(sem assunto)';
    return { from, subject, snippet: msg.data.snippet };
  }));
}

// Cria um evento de verdade no Google Calendar
// startDateTime/endDateTime no formato "AAAA-MM-DDTHH:MM:SS" (horário local do Brasil)
async function createCalendarEvent({ title, startDateTime, endDateTime }) {
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const result = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: title,
      start: { dateTime: startDateTime, timeZone: 'America/Sao_Paulo' },
      end: { dateTime: endDateTime, timeZone: 'America/Sao_Paulo' }
    }
  });
  return result.data;
}

// Eventos de hoje no Google Calendar
app.get('/api/calendar/today', checkAppKey, async (req, res) => {
  try {
    const events = await getTodayEvents();
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Últimos e-mails da caixa de entrada
app.get('/api/gmail/recent', checkAppKey, async (req, res) => {
  try {
    const messages = await getRecentEmails();
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Endpoint de chat com IA ----------
// Recebe { message: "texto do usuário" } e responde { reply: "texto da IA" }
// A IA recebe automaticamente a agenda de hoje e os e-mails recentes como contexto,
// e pode criar eventos de verdade na agenda quando o usuário pedir.
const tools = [
  {
    type: 'function',
    function: {
      name: 'criar_evento_agenda',
      description: 'Cria um novo compromisso/evento na agenda do usuário no Google Calendar.',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Título do evento' },
          data: { type: 'string', description: 'Data do evento no formato AAAA-MM-DD' },
          hora_inicio: { type: 'string', description: 'Horário de início no formato HH:MM (24 horas)' },
          duracao_minutos: { type: 'number', description: 'Duração em minutos. Use 60 se o usuário não especificar.' }
        },
        required: ['titulo', 'data', 'hora_inicio']
      }
    }
  }
];

app.post('/api/chat', checkAppKey, async (req, res) => {
  const userMessage = (req.body && req.body.message) ? String(req.body.message) : '';
  if (!userMessage.trim()) {
    return res.status(400).json({ error: 'faltou o campo "message"' });
  }

  try {
    let eventsText = 'Não foi possível carregar a agenda agora.';
    let emailsText = 'Não foi possível carregar os e-mails agora.';

    try {
      const events = await getTodayEvents();
      eventsText = events.length
        ? events.map(e => `- ${e.time}: ${e.title}`).join('\n')
        : 'Nenhum evento hoje.';
    } catch (e) { /* segue sem agenda */ }

    try {
      const emails = await getRecentEmails();
      emailsText = emails.length
        ? emails.map(m => `- De: ${m.from} | Assunto: ${m.subject}`).join('\n')
        : 'Nenhum e-mail recente.';
    } catch (e) { /* segue sem e-mails */ }

    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // formato AAAA-MM-DD

    const systemPrompt = `Você é o assistente pessoal do usuário. Responda em português do Brasil, de forma direta e simpática.
Hoje é ${hoje} (fuso horário de São Paulo/Brasil). Use essa data como referência para calcular "hoje", "amanhã", dias da semana, etc.

Agenda de hoje:
${eventsText}

E-mails recentes:
${emailsText}

Se o usuário pedir para marcar, criar ou agendar um compromisso, use a ferramenta criar_evento_agenda. Nunca diga que criou um evento sem realmente usar essa ferramenta.`;

    const firstResponse = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      max_tokens: 1000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      tools,
      tool_choice: 'auto'
    });

    const message = firstResponse.choices[0].message;
    let reply;

    if (message.tool_calls && message.tool_calls.length > 0) {
      const call = message.tool_calls[0];
      const args = JSON.parse(call.function.arguments);
      const duracao = args.duracao_minutos || 60;
      const startDateTime = `${args.data}T${args.hora_inicio}:00`;
      const startDate = new Date(`${startDateTime}-03:00`);
      const endDate = new Date(startDate.getTime() + duracao * 60000);
      const endDateTime = endDate.toISOString().slice(0, 19);

      try {
        await createCalendarEvent({ title: args.titulo, startDateTime, endDateTime });
        reply = `Prontinho! Marquei "${args.titulo}" para ${args.data} às ${args.hora_inicio}. ✅`;
      } catch (err) {
        reply = `Tentei marcar o compromisso, mas deu um erro: ${err.message}`;
      }
    } else {
      reply = message.content;
    }

    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Servidor do assistente pessoal está no ar.'));

app.listen(PORT, () => console.log('Rodando na porta ' + PORT));
