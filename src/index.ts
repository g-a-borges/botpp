export interface Env {
  AI: Ai;
  DB: D1Database;
  DEDUPE: KVNamespace;

  // Secrets (wrangler secret put ...)
  WHATSAPP_TOKEN: string;
  APP_SECRET: string;

  // Vars (wrangler.jsonc)
  VERIFY_TOKEN: string;
  PHONE_NUMBER_ID: string;
  GRAPH_VERSION: string;
  MODEL: string;
  TRANSCRIBE_MODEL: string;
  SYSTEM_PROMPT: string;
  BUSINESS_CONTEXT: string;
  OWNER_NUMBER: string;
  HANDOFF_KEYWORDS: string;
  MAX_MSGS_PER_HOUR: string;
}

interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  button?: { text: string };
  interactive?: {
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  audio?: { id: string; mime_type: string; voice?: boolean };
}

interface WhatsAppWebhookPayload {
  object: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      field: string;
      value: {
        metadata?: { phone_number_id: string; display_phone_number: string };
        contacts?: Array<{ profile?: { name?: string }; wa_id: string }>;
        messages?: WhatsAppMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
}

const MAX_HISTORY_TURNS = 10;
const MAX_REPLY_CHARS = 4000;
const PAUSE_TTL_SECONDS = 60 * 60 * 4; // bot pausado 4h após pedido de humano

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("WhatsApp AI bot está no ar.", { status: 200 });
    }

    if (url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    // 1) Handshake de verificação do webhook
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token && token === env.VERIFY_TOKEN) {
        return new Response(challenge ?? "", { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // 2) Assinatura HMAC — garante que a chamada veio da Meta
    const rawBody = await request.text();
    if (env.APP_SECRET) {
      const valid = await verifySignature(
        env.APP_SECRET,
        rawBody,
        request.headers.get("x-hub-signature-256"),
      );
      if (!valid) return new Response("Invalid signature", { status: 401 });
    }

    let payload: WhatsAppWebhookPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    // 3) Responde 200 na hora e processa em background
    ctx.waitUntil(processPayload(payload, env));
    return new Response("OK", { status: 200 });
  },
};

async function processPayload(payload: WhatsAppWebhookPayload, env: Env): Promise<void> {
  if (payload.object !== "whatsapp_business_account") return;

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages?.length) continue; // ignora statuses

      const contactName = value.contacts?.[0]?.profile?.name;

      for (const message of value.messages) {
        try {
          await handleMessage(message, contactName, env);
        } catch (err) {
          console.error("Falha ao processar mensagem", message.id, err);
        }
      }
    }
  }
}

async function handleMessage(
  message: WhatsAppMessage,
  contactName: string | undefined,
  env: Env,
): Promise<void> {
  const waId = message.from;

  // Deduplicação (a Meta reenvia eventos)
  const dedupeKey = `msg:${message.id}`;
  if (await env.DEDUPE.get(dedupeKey)) return;
  await env.DEDUPE.put(dedupeKey, "1", { expirationTtl: 60 * 60 * 24 });

  // Comandos do dono do número (você)
  if (env.OWNER_NUMBER && waId === env.OWNER_NUMBER) {
    const handled = await handleOwnerCommand(message, env);
    if (handled) return;
  }

  // Bot pausado para este contato (atendimento humano em andamento)
  if (await env.DEDUPE.get(`paused:${waId}`)) return;

  // Limite de mensagens por hora, por contato (controle de custo)
  const limit = Number(env.MAX_MSGS_PER_HOUR || "30");
  if (limit > 0 && !(await withinRateLimit(waId, limit, env))) {
    await sendWhatsAppText(
      waId,
      "Você enviou muitas mensagens em pouco tempo. Aguarde alguns minutos e tente novamente.",
      env,
    );
    return;
  }

  const userText = await extractText(message, env);
  if (!userText) {
    await sendWhatsAppText(
      waId,
      "Consigo responder mensagens de texto e áudio. Pode me contar como posso ajudar?",
      env,
    );
    return;
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO contacts (wa_id, name, first_seen, last_seen) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(wa_id) DO UPDATE SET last_seen = excluded.last_seen, " +
        "name = COALESCE(excluded.name, contacts.name)",
    ).bind(waId, contactName ?? null, now, now),
    env.DB.prepare(
      "INSERT INTO messages (wa_id, role, content, created_at) VALUES (?, 'user', ?, ?)",
    ).bind(waId, userText, now),
  ]);

  // Pedido explícito de atendimento humano
  if (wantsHuman(userText, env)) {
    await env.DEDUPE.put(`paused:${waId}`, "1", { expirationTtl: PAUSE_TTL_SECONDS });
    await sendWhatsAppText(
      waId,
      "Claro! Já avisei o responsável e ele vai te responder por aqui. Enquanto isso, pode deixar mais detalhes que eu repasso.",
      env,
    );
    if (env.OWNER_NUMBER) {
      await sendWhatsAppText(
        env.OWNER_NUMBER,
        `🔔 *Atendimento humano solicitado*\n` +
          `Contato: ${contactName ?? "sem nome"} (${waId})\n` +
          `Mensagem: "${userText.slice(0, 500)}"\n\n` +
          `O bot está pausado para este contato por 4h.\n` +
          `Para reativar antes: #ativar ${waId}`,
        env,
      );
    }
    return;
  }

  const history = await loadHistory(waId, env);
  const reply = await generateReply(userText, history, env);

  await env.DB.prepare(
    "INSERT INTO messages (wa_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)",
  )
    .bind(waId, reply, Date.now())
    .run();

  await sendWhatsAppText(waId, reply, env);
}

/* ------------------------------ entrada ------------------------------ */

async function extractText(message: WhatsAppMessage, env: Env): Promise<string | null> {
  if (message.type === "text" && message.text?.body) return message.text.body.trim();
  if (message.type === "button" && message.button?.text) return message.button.text.trim();
  if (message.type === "interactive") {
    const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
    if (reply?.title) return reply.title.trim();
  }
  if (message.type === "audio" && message.audio?.id) {
    return await transcribeAudio(message.audio.id, env);
  }
  return null;
}

/** Baixa o áudio do WhatsApp e transcreve com Whisper no Workers AI. */
async function transcribeAudio(mediaId: string, env: Env): Promise<string | null> {
  try {
    const version = env.GRAPH_VERSION || "v21.0";
    const auth = { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` };

    const metaRes = await fetch(`https://graph.facebook.com/${version}/${mediaId}`, {
      headers: auth,
    });
    if (!metaRes.ok) {
      console.error("Falha ao obter metadados do áudio", await metaRes.text());
      return null;
    }
    const meta = (await metaRes.json()) as { url?: string };
    if (!meta.url) return null;

    const audioRes = await fetch(meta.url, { headers: auth });
    if (!audioRes.ok) return null;
    const base64 = toBase64(await audioRes.arrayBuffer());

    const out = (await env.AI.run(env.TRANSCRIBE_MODEL as never, {
      audio: base64,
    } as never)) as { text?: string };

    const text = out?.text?.trim();
    return text ? text : null;
  } catch (err) {
    console.error("Erro na transcrição", err);
    return null;
  }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ------------------------------ IA ------------------------------ */

async function loadHistory(
  waId: string,
  env: Env,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const { results } = await env.DB.prepare(
    "SELECT role, content FROM messages WHERE wa_id = ? ORDER BY id DESC LIMIT ?",
  )
    .bind(waId, MAX_HISTORY_TURNS)
    .all<{ role: "user" | "assistant"; content: string }>();

  // Ordem cronológica; a última linha é a mensagem atual (já vai no prompt)
  return results.reverse().slice(0, -1);
}

async function generateReply(
  userText: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  env: Env,
): Promise<string> {
  const system = [env.SYSTEM_PROMPT, env.BUSINESS_CONTEXT]
    .filter(Boolean)
    .join("\n\n---\n\nInformações do negócio:\n");

  try {
    const result = (await env.AI.run(env.MODEL as never, {
      messages: [
        { role: "system", content: system },
        ...history,
        { role: "user", content: userText },
      ],
      max_tokens: 512,
      temperature: 0.5,
    } as never)) as { response?: string } | string;

    const text =
      typeof result === "string" ? result : (result?.response ?? "").toString().trim();

    if (!text) return "Desculpe, não consegui responder agora. Pode reformular?";
    return text.slice(0, MAX_REPLY_CHARS);
  } catch (err) {
    console.error("Erro no Workers AI", err);
    return "Tive um problema técnico para responder agora. Já avisei o responsável.";
  }
}

/* ------------------------------ regras ------------------------------ */

function wantsHuman(text: string, env: Env): boolean {
  const keywords = (env.HANDOFF_KEYWORDS || "atendente,humano,pessoa")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  const normalized = text.toLowerCase();
  return keywords.some((k) => normalized.includes(k));
}

async function withinRateLimit(waId: string, limit: number, env: Env): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 3_600_000);
  const key = `rate:${waId}:${bucket}`;
  const current = Number((await env.DEDUPE.get(key)) ?? "0");
  if (current >= limit) return false;
  await env.DEDUPE.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}

/** Comandos do dono: #ativar <numero> | #pausar <numero> | #status */
async function handleOwnerCommand(message: WhatsAppMessage, env: Env): Promise<boolean> {
  const body = message.text?.body?.trim();
  if (!body || !body.startsWith("#")) return false;

  const [cmd, arg] = body.split(/\s+/);

  if (cmd === "#ativar" && arg) {
    await env.DEDUPE.delete(`paused:${arg}`);
    await sendWhatsAppText(env.OWNER_NUMBER, `Bot reativado para ${arg}.`, env);
    return true;
  }

  if (cmd === "#pausar" && arg) {
    await env.DEDUPE.put(`paused:${arg}`, "1", { expirationTtl: PAUSE_TTL_SECONDS });
    await sendWhatsAppText(env.OWNER_NUMBER, `Bot pausado para ${arg} por 4h.`, env);
    return true;
  }

  if (cmd === "#status") {
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS total, MAX(last_seen) AS ultimo FROM contacts",
    ).all<{ total: number; ultimo: number }>();
    const row = results[0];
    await sendWhatsAppText(
      env.OWNER_NUMBER,
      `Contatos: ${row?.total ?? 0}\nÚltimo atendimento: ${
        row?.ultimo ? new Date(row.ultimo).toLocaleString("pt-BR") : "—"
      }`,
      env,
    );
    return true;
  }

  return false;
}

/* ------------------------------ saída ------------------------------ */

async function sendWhatsAppText(to: string, body: string, env: Env): Promise<void> {
  const version = env.GRAPH_VERSION || "v21.0";
  const res = await fetch(
    `https://graph.facebook.com/${version}/${env.PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: body.slice(0, MAX_REPLY_CHARS) },
      }),
    },
  );

  if (!res.ok) {
    console.error("Falha ao enviar mensagem", res.status, await res.text());
  }
}

async function verifySignature(
  appSecret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  if (!header) return false;
  const expected = header.startsWith("sha256=") ? header.slice(7) : header;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (hex.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
