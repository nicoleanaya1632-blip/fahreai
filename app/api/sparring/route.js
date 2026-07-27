export const maxDuration = 60;

export async function POST(request) {
  var body = await request.json();
  var systemPrompt = body.systemPrompt;
  var messages = body.messages;

  var apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "API key not configured" }, { status: 500 });
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

function buildRateMsg(res, data) {
  var msg = (data && data.error && data.error.message) || "";
  var esDia = /per day|\(TPD\)|\(RPD\)/i.test(msg);
  var esTokens = /token/i.test(msg) || !/request/i.test(msg);
  var limit = (msg.match(/Limit\s+([\d.]+)/i) || [])[1];
  var used = (msg.match(/Used\s+([\d.]+)/i) || [])[1];
  if (!limit) limit = res.headers.get(esTokens ? "x-ratelimit-limit-tokens" : "x-ratelimit-limit-requests");

  var unidad = esTokens ? "tokens" : "consultas";
  var limF = fmtNum(limit);
  var usedF = fmtNum(used);

  if (esDia) {
    var out = "⛔ Límite DIARIO alcanzado";
    if (limF) out += ": " + limF + " " + unidad + "/día";
    if (usedF) out += " (ya usaste " + usedF + ")";
    out += ". Se renueva a medianoche (hora del Pacífico).";
    return out;
  }

  var out2 = "⏳ Límite POR MINUTO alcanzado";
  if (limF) out2 += ": " + limF + " " + unidad + "/min";
  if (usedF) out2 += " (usaste " + usedF + " este minuto)";
  out2 += ". Espera un minuto y reintenta, o vuelve a enviar tu pregunta más corta.";
  return out2;
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

    if (res.status === 429 || (data && data.error && /rate.?limit/i.test(data.error.message || ""))) {
      var hasBigMaterial = false;
      for (var mi = 0; mi < groqMessages.length; mi++) {
        var mc = groqMessages[mi].content || "";
        if (groqMessages[mi].role === "user" && mc.indexOf("MATERIAL DE REFERENCIA") !== -1 && mc.length > 8000) { hasBigMaterial = true; break; }
      }
      return Response.json({ error: buildRateMsg(res, data), canSummarize: hasBigMaterial }, { status: 429 });
    }

    if (data.error) {
      return Response.json({ error: data.error.message || "Groq API error" }, { status: 500 });
    }

    var text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "Sin respuesta.";
    return Response.json({ text: text });

  } catch (err) {
    return Response.json({ error: "Error de conexión con Groq" }, { status: 500 });
  }
}
