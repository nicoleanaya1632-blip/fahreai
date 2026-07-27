export const maxDuration = 60;

export async function POST(request) {
  var body = await request.json();
  var systemPrompt = body.systemPrompt;
  var messages = body.messages;

  var apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "API key not configured" }, { status: 500 });
  }

  // Modo "compactar": resume la parte antigua de una conversación larga (se hace una sola vez)
  if (body.compactHistory) {
    try {
      var cres = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: "Eres un asistente que comprime conversaciones de trabajo en español peruano, conservando lo esencial." },
            { role: "user", content: "Comprime la parte antigua de esta conversación conservando lo que hace falta para seguir el hilo: marca o proyecto, documentos revisados y su contenido clave, las posiciones y observaciones de cada participante, y lo que quedó pendiente. Sé denso y breve, máximo 220 palabras, en prosa, sin encabezados ni listas:\n\n" + String(body.compactHistory) }
          ],
          max_tokens: 550,
          temperature: 0.3,
        }),
      });
      var cdata = await cres.json();
      if (cdata.choices && cdata.choices[0]) {
        return Response.json({ compact: cdata.choices[0].message.content });
      }
      return Response.json({ error: "No se pudo compactar" }, { status: 500 });
    } catch (e) {
      return Response.json({ error: "No se pudo compactar" }, { status: 500 });
    }
  }

  // Modo "contexto de traspaso": resume la conversación para continuarla en un chat nuevo
  if (body.handoffConversation) {
    try {
      var hres = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: "Eres un asistente que resume conversaciones de trabajo en español peruano, de forma breve y útil." },
            { role: "user", content: "Resume esta conversación para poder continuarla en un chat nuevo sin perder el hilo. Incluye: qué marca/proyecto se está discutiendo, qué documentos se revisaron, los puntos clave que dijo cada participante, y qué quedó pendiente. Máximo 200 palabras, en prosa, sin encabezados ni listas:\n\n" + String(body.handoffConversation) }
          ],
          max_tokens: 500,
          temperature: 0.3,
        }),
      });
      var hdata = await hres.json();
      if (hdata.choices && hdata.choices[0]) {
        return Response.json({ handoff: hdata.choices[0].message.content });
      }
      return Response.json({ error: "No se pudo generar el contexto" }, { status: 500 });
    } catch (e) {
      return Response.json({ error: "No se pudo generar el contexto" }, { status: 500 });
    }
  }

  // Modo "solo resumir": el frontend resume el material UNA vez y lo reparte a todos los twins de la mesa
  if (body.summarizeMaterial) {
    try {
      var summ = await summarizeText(apiKey, String(body.summarizeMaterial));
      return Response.json({ summary: summ });
    } catch (e) {
      return Response.json({ error: "No se pudo resumir el material" }, { status: 500 });
    }
  }

  // Estimate tokens roughly (1 token ≈ 4 chars)
  var systemTokens = Math.ceil(systemPrompt.length / 4);
  var messageTokens = 0;
  for (var i = 0; i < messages.length; i++) {
    messageTokens += Math.ceil((messages[i].content || "").length / 4);
  }
  var totalEstimate = systemTokens + messageTokens + 900;

  // If fits within limit, send directly
  if (totalEstimate < 11000) {
    return await callGroq(apiKey, systemPrompt, messages, 900);
  }

  // Otherwise: chunk and summarize the largest user message
  var largestIdx = 0;
  var largestLen = 0;
  for (var i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && (messages[i].content || "").length > largestLen) {
      largestLen = (messages[i].content || "").length;
      largestIdx = i;
    }
  }

  var fullText = messages[largestIdx].content || "";

  // Split the material from the question
  var splitMarker = "---\nMATERIAL DE REFERENCIA";
  var questionPart = fullText;
  var materialPart = "";

  var splitIdx = fullText.indexOf(splitMarker);
  if (splitIdx !== -1) {
    questionPart = fullText.substring(0, splitIdx).trim();
    materialPart = fullText.substring(splitIdx).trim();
  } else if (fullText.length > 5000) {
    materialPart = fullText;
    questionPart = "Evalúa y responde sobre el siguiente material.";
  }

  // If material is short enough after split, send directly
  var afterSplitEstimate = systemTokens + Math.ceil(questionPart.length / 4) + Math.ceil(materialPart.length / 4) + 900;
  if (afterSplitEstimate < 11000 || materialPart.length < 28000) {
    return await callGroq(apiKey, systemPrompt, messages, 900);
  }

  // Resumir el material (una sola pasada). Si es una mesa, el frontend ya lo resumió antes y no llega acá.
  var compressedMaterial = await summarizeText(apiKey, materialPart);
  await new Promise(function(r) { setTimeout(r, 12000); });
  var newContent = questionPart + "\n\n---\nRESUMEN DEL MATERIAL:\n" + compressedMaterial;

  var newMessages = messages.slice();
  newMessages[largestIdx] = { role: messages[largestIdx].role, content: newContent };

  return await callGroq(apiKey, systemPrompt, newMessages, 900);
}

// ─── AUTO-RETRY: if rate limited, wait and retry up to 3 times ───────────────
async function fetchWithRetry(url, options, maxRetries) {
  if (!maxRetries) maxRetries = 1; // un solo reintento: fallar rápido, nunca colgar minutos
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    var res = await fetch(url, options);
    if (res.status === 429 && attempt < maxRetries) {
      var retryAfter = res.headers.get("retry-after");
      var waitMs = retryAfter ? Math.min(parseFloat(retryAfter) * 1000 + 1000, 25000) : 15000;
      await new Promise(function(r) { setTimeout(r, waitMs); });
      continue;
    }
    return res; // devuelve la respuesta (incl. 429) para que el error se muestre de inmediato
  }
}

// ─── CIERRE ANTI-RESUMEN: fuerza punto de vista cuando hay material adjunto ───
var POV_CLOSER = "\n\n---\nINSTRUCCIÓN FINAL, la más importante y por encima de todo lo anterior: NO resumas ni describas el material de arriba — la persona ya sabe lo que hizo, describírselo no le sirve de nada. Reacciona con tu punto de vista real desde tu área: qué es lo más fuerte y por qué, qué NO te cierra o qué te preocupa, qué le falta, y al menos una idea concreta o una objeción puntual que aportes tú. Habla como en una reunión real de Fahrenheit — con opinión, no con un resumen. Si algo está flojo, dilo.";

async function summarizeText(apiKey, materialPart) {
  var chunkSize = 15000;
  var chunks = [];
  for (var c = 0; c < materialPart.length; c += chunkSize) {
    chunks.push(materialPart.substring(c, c + chunkSize));
  }

  var summaries = [];
  for (var ci = 0; ci < chunks.length; ci++) {
    if (ci > 0) {
      await new Promise(function(r) { setTimeout(r, 12000); });
    }

    var sumMessages = [{
      role: "user",
      content: "Resume el siguiente texto de forma MUY compacta pero completa: captura marca, objetivo, insight, estrategia, rutas creativas y datos clave en el menor número de palabras posible. Sin relleno, sin repetir, sin introducción. Solo el resumen:\n\n" + chunks[ci]
    }];

    try {
      var sumRes = await fetchWithRetry("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "system", content: "Eres un asistente que resume textos de forma densa y precisa en español." }].concat(sumMessages),
          max_tokens: 650,
          temperature: 0.3,
        }),
      });
      var sumData = await sumRes.json();
      if (sumData.choices && sumData.choices[0]) {
        summaries.push(sumData.choices[0].message.content);
      } else {
        summaries.push(chunks[ci].substring(0, 2000));
      }
    } catch (e) {
      summaries.push(chunks[ci].substring(0, 2000));
    }
  }

  return summaries.join("\n\n");
}

function fmtNum(n) {
  n = parseInt(n, 10);
  if (isNaN(n)) return null;
  return n.toLocaleString("es-PE");
}

// Lee los contadores reales que Groq manda en cada respuesta.
// tokens = límite por MINUTO (TPM) · requests = límite por DÍA (RPD)
function readLimits(res) {
  function num(h) { var v = res.headers.get(h); if (v === null) return null; var n = parseFloat(v); return isNaN(n) ? null : n; }
  var lt = num("x-ratelimit-limit-tokens");
  var rt = num("x-ratelimit-remaining-tokens");
  var lr = num("x-ratelimit-limit-requests");
  var rr = num("x-ratelimit-remaining-requests");
  if (lt === null && lr === null) return null;
  return {
    tokensLimit: lt, tokensRemaining: rt, tokensReset: res.headers.get("x-ratelimit-reset-tokens"),
    reqLimit: lr, reqRemaining: rr, reqReset: res.headers.get("x-ratelimit-reset-requests"),
  };
}

function classifyLimit(res, data, lastUserChars, totalChars) {
  var msg = (data && data.error && data.error.message) || "";
  var esDia = /per day|\(TPD\)|\(RPD\)/i.test(msg);
  var demasiadoGrande = /request too large|reduce your message size/i.test(msg);
  var esTokens = /token/i.test(msg) || !/request/i.test(msg);

  var limit = (msg.match(/Limit\s+([\d.]+)/i) || [])[1];
  var used = (msg.match(/Used\s+([\d.]+)/i) || [])[1];
  var requested = (msg.match(/Requested\s+([\d.]+)/i) || [])[1];
  var again = (msg.match(/try again in\s+([^.]+)/i) || [])[1];
  if (!limit) limit = res.headers.get(esTokens ? "x-ratelimit-limit-tokens" : "x-ratelimit-limit-requests");

  var unidad = esTokens ? "tokens" : "consultas";
  var limF = fmtNum(limit);
  var usedF = fmtNum(used);
  var reqF = fmtNum(requested);

  // Límite del día: no hay nada que hacer hasta el reset
  if (esDia) {
    var mD = "⛔ Límite DIARIO alcanzado";
    if (limF) mD += ": " + limF + " " + unidad + "/día";
    if (usedF) mD += " (ya usaste " + usedF + ")";
    mD += ". Se renueva a medianoche (hora del Pacífico).";
    return { kind: "daily", message: mD };
  }

  if (demasiadoGrande) {
    // ¿El peso viene del mensaje nuevo, o de todo lo acumulado en el chat?
    var esMensajeNuevo = totalChars > 0 && (lastUserChars / totalChars) > 0.55;

    if (esMensajeNuevo) {
      var m1 = "✂️ Esta sola pregunta ya supera todo tu límite por minuto";
      if (reqF && limF) m1 += ": pide " + reqF + " " + unidad + " y el tope es " + limF + " " + unidad + "/min";
      m1 += ". Hazla más corta o adjunta un documento más liviano — puedes usar el botón de abajo para trabajar con un resumen.";
      return { kind: "single_too_big", message: m1 };
    }

    var m3 = "📚 Esta conversación ya acumuló demasiado contenido y no entra en tu límite por minuto";
    if (reqF && limF) m3 += " (pide " + reqF + " " + unidad + " y el tope es " + limF + " " + unidad + "/min)";
    m3 += ". No es tu pregunta: es todo lo anterior sumado. Lo mejor es abrir un chat nuevo — abajo puedes generar un contexto para no perder el hilo.";
    return { kind: "accumulated", message: m3 };
  }

  // Demasiadas peticiones en poco tiempo
  var m2 = "⏳ Hiciste varias consultas muy seguidas y llegaste al límite por minuto";
  if (limF) m2 += " (" + limF + " " + unidad + "/min)";
  if (usedF) m2 += ", ya usaste " + usedF;
  m2 += ". Espera " + (again ? "~" + again.trim() : "un minuto") + " y reintenta — tu cupo del día sigue disponible.";
  return { kind: "rate_minute", message: m2 };
}

async function callGroq(apiKey, systemPrompt, messages, maxTokens) {
  var groqMessages = [{ role: "system", content: systemPrompt }];
  for (var i = 0; i < messages.length; i++) {
    groqMessages.push({ role: messages[i].role, content: messages[i].content });
  }

  // Si el último mensaje de usuario trae material (es largo), forzar punto de vista al final
  for (var k = groqMessages.length - 1; k >= 0; k--) {
    if (groqMessages[k].role === "user") {
      if ((groqMessages[k].content || "").length > 1200) {
        groqMessages[k] = { role: "user", content: groqMessages[k].content + POV_CLOSER };
      }
      break;
    }
  }

  try {
    var res = await fetchWithRetry("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: groqMessages,
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });

    var data = await res.json();

    var errMsg = (data && data.error && data.error.message) || "";
    if (res.status === 429 || res.status === 413 || /rate.?limit|request too large|reduce your message size/i.test(errMsg)) {
      var totalChars = 0, lastUserChars = 0, hasBigMaterial = false;
      for (var mi = 0; mi < groqMessages.length; mi++) {
        var mc = groqMessages[mi].content || "";
        totalChars += mc.length;
        if (groqMessages[mi].role === "user") {
          lastUserChars = mc.length;
          if (mc.indexOf("MATERIAL DE REFERENCIA") !== -1 && mc.length > 6000) hasBigMaterial = true;
        }
      }
      var cls = classifyLimit(res, data, lastUserChars, totalChars);
      return Response.json({
        error: cls.message,
        errorKind: cls.kind,
        canSummarize: hasBigMaterial && cls.kind === "single_too_big",
        limits: readLimits(res),
      }, { status: 429 });
    }

    if (data.error) {
      return Response.json({ error: data.error.message || "Groq API error" }, { status: 500 });
    }

    var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "Sin respuesta.";
    return Response.json({ text: text, limits: readLimits(res) });

  } catch (err) {
    return Response.json({ error: "Error de conexión con Groq" }, { status: 500 });
  }
}
