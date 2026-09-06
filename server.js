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
const REDIRECT_URI = process.env.REDIRECT_URI;
const APP_KEY = process.env.APP_KEY;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const groq = new Groq({ apiKey: GROQ_API_KEY });

if (REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.readonly'
];

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
  res.redirect(url);
});

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

// ---------- Funções auxiliares do Google ----------

// Retorna os eventos de uma data específica (AAAA-MM-DD), com id incluído
async function getEventsForDate(dateStr) {
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const timeMin = new Date(`${dateStr}T00:00:00-03:00`).toISOString();
  const timeMax = new Date(`${dateStr}T23:59:59-03:00`).toISOString();
  const result = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime'
  });
  return (result.data.items || []).map(e => ({
    id: e.id,
    title: e.summary || '(sem título)',
    time: e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo', hour12: false })
      : 'dia todo'
  }));
}

async function getTodayEvents() {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  return getEventsForDate(hoje);
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

// Cancela evento(s) de uma data, filtrando por horário e/ou trecho do título
async function cancelarEvento({ data, hora_inicio, titulo_contendo }) {
  const events = await getEventsForDate(data);
  let candidatos = events;
  if (hora_inicio) candidatos = candidatos.filter(e => e.time === hora_inicio);
  if (titulo_contendo) candidatos = candidatos.filter(e => e.title.toLowerCase().includes(titulo_contendo.toLowerCase()));

  if (candidatos.length === 0) return { status: 'nao_encontrado' };
  if (candidatos.length > 1) return { status: 'multiplos', eventos: candidatos };

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  await calendar.events.delete({ calendarId: 'primary', eventId: candidatos[0].id });
  return { status: 'cancelado', evento: candidatos[0] };
}

// ---------- Clima (OpenWeatherMap — plano gratuito, precisa de chave própria) ----------

async function getWeatherForecast(cidade) {
  try {
    if (!OPENWEATHER_API_KEY) {
      return { erro: 'A chave OPENWEATHER_API_KEY não está configurada no servidor.' };
    }
    const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(cidade)},BR&appid=${OPENWEATHER_API_KEY}&units=metric&lang=pt_br`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (String(data.cod) !== '200') {
      return { erro: data.message || 'Não foi possível obter a previsão do tempo.' };
    }

    const porDia = {};
    for (const item of data.list) {
      const dia = item.dt_txt.slice(0, 10);
      if (!porDia[dia]) porDia[dia] = { temps: [], descricoes: [] };
      porDia[dia].temps.push(item.main.temp);
      porDia[dia].descricoes.push(item.weather[0].description);
    }

    const dias = Object.entries(porDia).slice(0, 4).map(([dia, info]) => ({
      data: dia,
      temperatura_maxima: Math.round(Math.max(...info.temps)),
      temperatura_minima: Math.round(Math.min(...info.temps)),
      descricao: info.descricoes[Math.floor(info.descricoes.length / 2)]
    }));

    return { cidade: data.city.name, previsao_proximos_dias: dias };
  } catch (err) {
    return { erro: 'Falha ao consultar o clima: ' + err.message };
  }
}

// ---------- Memória (Upstash Redis — plano gratuito, guarda entre conversas) ----------

async function salvarMemoria(informacao) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return { erro: 'Memória não configurada no servidor (faltam UPSTASH_REDIS_REST_URL / TOKEN).' };
  }
  try {
    const url = `${UPSTASH_URL}/rpush/sextafeira_memorias/${encodeURIComponent(informacao)}`;
    await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    return { status: 'salvo', informacao };
  } catch (err) {
    return { erro: 'Falha ao salvar na memória: ' + err.message };
  }
}

async function buscarMemorias(limite = 60) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return [];
  try {
    const url = `${UPSTASH_URL}/lrange/sextafeira_memorias/-${limite}/-1`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    const data = await resp.json();
    return data.result || [];
  } catch (err) {
    return [];
  }
}

// ---------- Mapa e rotas (Nominatim + OSRM, gratuitos, sem chave) ----------

async function buscarRota({ destino, lat, lon }) {
  if (lat === undefined || lon === undefined) {
    return { erro: 'Não tenho sua localização atual. Peça para o usuário abrir o mapa no app para ativar a localização.' };
  }
  try {
    const geoResp = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(destino)}`, {
      headers: { 'User-Agent': 'SextaFeira-Assistente-Pessoal/1.0' }
    });
    const geoData = await geoResp.json();
    if (!geoData.length) return { erro: `Não encontrei o endereço "${destino}".` };

    const destLat = parseFloat(geoData[0].lat);
    const destLon = parseFloat(geoData[0].lon);

    const rotaUrl = `https://router.project-osrm.org/route/v1/driving/${lon},${lat};${destLon},${destLat}?overview=false`;
    const rotaResp = await fetch(rotaUrl);
    const rotaData = await rotaResp.json();
    if (!rotaData.routes || !rotaData.routes.length) return { erro: 'Não consegui calcular uma rota até lá.' };

    const rota = rotaData.routes[0];
    return {
      destino: geoData[0].display_name,
      destino_lat: destLat,
      destino_lon: destLon,
      distancia_km: (rota.distance / 1000).toFixed(1),
      duracao_min: Math.round(rota.duration / 60)
    };
  } catch (err) {
    return { erro: 'Falha ao calcular rota: ' + err.message };
  }
}

// ---------- Rotas simples de leitura (usadas fora do chat também) ----------

app.get('/api/calendar/today', checkAppKey, async (req, res) => {
  try {
    const events = await getTodayEvents();
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gmail/recent', checkAppKey, async (req, res) => {
  try {
    const messages = await getRecentEmails();
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Endpoint de chat com IA ----------

const tools = [
  {
    type: 'function',
    function: {
      name: 'consultar_agenda',
      description: 'Consulta os compromissos existentes numa data específica (hoje, amanhã, ou qualquer outra data).',
      parameters: {
        type: 'object',
        properties: {
          data: { type: 'string', description: 'Data a consultar, no formato AAAA-MM-DD' }
        },
        required: ['data']
      }
    }
  },
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
  },
  {
    type: 'function',
    function: {
      name: 'cancelar_evento',
      description: 'Cancela (remove) um compromisso existente na agenda numa data específica. Use consultar_agenda antes, se precisar confirmar qual evento é.',
      parameters: {
        type: 'object',
        properties: {
          data: { type: 'string', description: 'Data do evento a cancelar, no formato AAAA-MM-DD' },
          hora_inicio: { type: 'string', description: 'Horário de início do evento a cancelar, formato HH:MM (24h). Opcional.' },
          titulo_contendo: { type: 'string', description: 'Trecho do título do evento a cancelar. Opcional.' }
        },
        required: ['data']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'consultar_clima',
      description: 'Consulta a previsão do tempo dos próximos dias para uma cidade.',
      parameters: {
        type: 'object',
        properties: {
          cidade: { type: 'string', description: 'Nome da cidade, ex: "Goiânia" ou "São Paulo"' }
        },
        required: ['cidade']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'salvar_memoria',
      description: 'Salva permanentemente uma informação importante sobre o usuário, um projeto ou trabalho, para lembrar em conversas futuras.',
      parameters: {
        type: 'object',
        properties: {
          informacao: { type: 'string', description: 'A informação a guardar, de forma clara e objetiva, em uma frase.' }
        },
        required: ['informacao']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'buscar_rota',
      description: 'Calcula a distância, tempo estimado e caminho até um destino, a partir da localização atual do usuário.',
      parameters: {
        type: 'object',
        properties: {
          destino: { type: 'string', description: 'Endereço, nome de lugar ou cidade de destino' }
        },
        required: ['destino']
      }
    }
  }
];

async function executarFerramenta(nome, args, contexto) {
  if (nome === 'consultar_agenda') {
    const events = await getEventsForDate(args.data);
    return { data: args.data, eventos: events };
  }
  if (nome === 'criar_evento_agenda') {
    const duracao = args.duracao_minutos || 60;
    const startDateTime = `${args.data}T${args.hora_inicio}:00`;
    const startDate = new Date(`${startDateTime}-03:00`);
    const endDate = new Date(startDate.getTime() + duracao * 60000);
    const endDateTime = endDate.toISOString().slice(0, 19);
    await createCalendarEvent({ title: args.titulo, startDateTime, endDateTime });
    return { status: 'criado', titulo: args.titulo, data: args.data, hora_inicio: args.hora_inicio };
  }
  if (nome === 'cancelar_evento') {
    return await cancelarEvento(args);
  }
  if (nome === 'consultar_clima') {
    return await getWeatherForecast(args.cidade);
  }
  if (nome === 'salvar_memoria') {
    return await salvarMemoria(args.informacao);
  }
  if (nome === 'buscar_rota') {
    return await buscarRota({ destino: args.destino, lat: contexto.lat, lon: contexto.lon });
  }
  return { error: 'ferramenta desconhecida' };
}

app.post('/api/chat', checkAppKey, async (req, res) => {
  const userMessage = (req.body && req.body.message) ? String(req.body.message) : '';
  const contexto = { lat: req.body ? req.body.lat : undefined, lon: req.body ? req.body.lon : undefined };
  const historico = Array.isArray(req.body && req.body.historico)
    ? req.body.historico
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-12)
        .map(m => ({ role: m.role, content: m.content }))
    : [];
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

    let memoriasText = 'Nenhuma memória guardada ainda.';
    try {
      const memorias = await buscarMemorias();
      if (memorias.length > 0) memoriasText = memorias.map(m => `- ${m}`).join('\n');
    } catch (e) { /* segue sem memórias */ }

    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

    const systemPrompt = `Você é SextaFeira, o assistente pessoal do usuário, com uma personalidade inspirada no Jarvis (Homem de Ferro): extremamente competente, calmo, educado e com um toque sutil de humor seco e elegante — nunca exagerado ou bobo. Trate o usuário com um respeito levemente formal (pode chamá-lo ocasionalmente de forma cortês), mas sem ser frio. Seja eficiente e direto ao ajudar, e permita-se um comentário espirituoso ocasional quando fizer sentido, sem forçar a piada. Responda em português do Brasil, em texto simples (sem markdown — sem asteriscos, #, ou listas com traço), já que a resposta é lida em voz alta. Se perguntarem seu nome, diga que é SextaFeira.
Hoje é ${hoje} (fuso horário de São Paulo/Brasil). Use essa data como referência para calcular "hoje", "amanhã", dias da semana, etc.

Agenda de hoje (referência rápida):
${eventsText}

E-mails recentes:
${emailsText}

Memórias guardadas de conversas anteriores (fatos sobre o usuário, projetos e trabalhos que ele fez com você):
${memoriasText}

Regras importantes:
- Use as memórias guardadas acima naturalmente na conversa, quando forem relevantes, como se você realmente lembrasse.
- Quando o usuário contar algo importante e duradouro sobre si mesmo, um projeto, trabalho ou preferência (não algo trivial ou passageiro), use a ferramenta salvar_memoria para guardar isso permanentemente. Salve em frases curtas e claras.
- Se o usuário perguntar sobre compromissos em qualquer data que não seja hoje (ex: amanhã, sexta-feira, dia 20), use a ferramenta consultar_agenda para essa data antes de responder. Não invente.
- Se o usuário pedir para marcar/criar um compromisso, use criar_evento_agenda.
- Se o usuário pedir para cancelar/remover/desmarcar um compromisso, use cancelar_evento. Se a ferramenta retornar "multiplos", pergunte ao usuário qual dos eventos ele quer cancelar, listando os horários e títulos.
- Se o usuário pedir para cancelar E marcar outro no mesmo pedido, use as DUAS ferramentas (cancelar_evento e depois criar_evento_agenda) — nunca diga que cancelou se não usou a ferramenta de cancelar.
- Se o usuário perguntar sobre o tempo, clima ou previsão, use a ferramenta consultar_clima. Se ele não disser a cidade, pergunte qual cidade antes de consultar. O campo "descricao" já vem em português, pronto para usar na resposta. Se a ferramenta retornar um campo "erro", copie essa mensagem de erro literalmente na resposta (modo de diagnóstico temporário).
- Se o usuário pedir para salvar/lembrar algo, ou perguntar como chegar a algum lugar, use as ferramentas adequadas: salvar_memoria ou buscar_rota. Para buscar_rota, se vier um campo "erro" pedindo para abrir o mapa, explique isso ao usuário educadamente.
- Nunca diga que fez algo (criar, cancelar, editar) sem realmente ter usado a ferramenta correspondente e recebido confirmação.`;

    let messages = [
      { role: 'system', content: systemPrompt },
      ...historico,
      { role: 'user', content: userMessage }
    ];

    let reply = null;
    let acaoFrontend = null;
    for (let i = 0; i < 4; i++) {
      const response = await groq.chat.completions.create({
        model: 'openai/gpt-oss-120b',
        max_tokens: 1000,
        messages,
        tools,
        tool_choice: 'auto'
      });

      const message = response.choices[0].message;

      if (message.tool_calls && message.tool_calls.length > 0) {
        messages.push(message);
        for (const call of message.tool_calls) {
          let resultado;
          try {
            const args = JSON.parse(call.function.arguments || '{}');
            resultado = await executarFerramenta(call.function.name, args, contexto);
          } catch (err) {
            resultado = { error: err.message };
          }
          if (call.function.name === 'buscar_rota' && resultado && !resultado.erro) {
            acaoFrontend = {
              tipo: 'navegar',
              lat: resultado.destino_lat,
              lon: resultado.destino_lon,
              nome: resultado.destino
            };
          }
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(resultado)
          });
        }
        continue; // deixa o modelo ver o resultado e responder de novo
      }

      reply = message.content;
      break;
    }

    if (reply === null) reply = 'Desculpa, tive um problema para concluir isso. Pode tentar de novo?';

    res.json({ reply, acao: acaoFrontend });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Servidor do assistente pessoal está no ar.'));

app.listen(PORT, () => console.log('Rodando na porta ' + PORT));
