/* ════════════════════════════════════════════════════════════
   ApiarIA Full · providers.js v3
   5 proveedores: Gemini · Groq · Cerebras · Claude · Perplexity
   - Cascada de modelos dentro de cada proveedor
   - FAILOVER automático: si un proveedor se tuesta (error,
     cuota agotada o no responde en 60s) salta al siguiente
     proveedor que tenga key configurada.
   - Regulador de velocidad por proveedor (capa gratuita)
   ════════════════════════════════════════════════════════════ */

const PROVEEDORES = {
  gemini: {
    nombre: "Gemini (Google)",
    modelosCascada: ["gemini-2.5-flash-lite","gemini-2.5-flash","gemini-2.0-flash-lite","gemini-flash-latest"],
    modeloDefault: "gemini-2.5-flash-lite",
    modeloSintesis: "gemini-2.5-flash",
    keyStorage: "apiaria_key_gemini",
    urlKeys: "https://aistudio.google.com/apikey",
    prefijo: "AIza"
  },
  groq: {
    nombre: "Groq (Llama 70B · ultra rápido)",
    modelosCascada: ["llama-3.3-70b-versatile","llama-3.1-8b-instant","gemma2-9b-it"],
    modeloDefault: "llama-3.3-70b-versatile",
    modeloSintesis: "llama-3.3-70b-versatile",
    keyStorage: "apiaria_key_groq",
    urlKeys: "https://console.groq.com/keys",
    prefijo: "gsk_"
  },
  cerebras: {
    nombre: "Cerebras (1M tokens/día)",
    modelosCascada: ["llama-3.3-70b","llama3.1-8b","gpt-oss-120b","zai-glm-4.7"],
    modeloDefault: "llama-3.3-70b",
    modeloSintesis: "llama-3.3-70b",
    keyStorage: "apiaria_key_cerebras",
    urlKeys: "https://cloud.cerebras.ai",
    prefijo: "csk-"
  },
  anthropic: {
    nombre: "Claude (Anthropic)",
    modelosCascada: ["claude-haiku-4-5"],
    modeloDefault: "claude-haiku-4-5",
    modeloSintesis: "claude-sonnet-4-5",
    keyStorage: "apiaria_key_anthropic",
    urlKeys: "https://console.anthropic.com/settings/keys",
    prefijo: "sk-ant-"
  },
  perplexity: {
    nombre: "Perplexity",
    modelosCascada: ["sonar"],
    modeloDefault: "sonar",
    modeloSintesis: "sonar",
    keyStorage: "apiaria_key_perplexity",
    urlKeys: "https://www.perplexity.ai/settings/api",
    prefijo: "pplx-"
  }
};

/* Orden de failover si el proveedor pedido se tuesta */
const ORDEN_FAILOVER = ["groq","cerebras","gemini","anthropic","perplexity"];
const TIMEOUT_MS = 60000; // si no responde en 60s → siguiente

function getProviderKey(p){ return localStorage.getItem(PROVEEDORES[p].keyStorage) || ""; }
function setProviderKey(p,k){ if(k) localStorage.setItem(PROVEEDORES[p].keyStorage,k.trim()); else localStorage.removeItem(PROVEEDORES[p].keyStorage); }

const dormir = ms => new Promise(r=>setTimeout(r,ms));
function extraerEspera(msg){
  const m = String(msg).match(/retry in ([0-9.]+)\s*s/i);
  return m ? Math.ceil(parseFloat(m[1])*1000)+500 : null;
}

/* Regulador por proveedor (capa gratuita):
   gemini 15 RPM → 4.2s · groq 30 RPM → 2.1s · cerebras 30 RPM → 2.1s */
const THROTTLE_MS = { gemini:4200, groq:2100, cerebras:2100, anthropic:0, perplexity:1200 };
const _turno = {};
async function tomarTurno(p){
  const gap = THROTTLE_MS[p]||0; if(!gap) return;
  const ahora = Date.now();
  const t = Math.max(ahora, (_turno[p]||0)+gap);
  _turno[p] = t;
  if(t>ahora) await dormir(t-ahora);
}

/* fetch con timeout (aborta si el proveedor no responde rápido) */
async function fetchTO(url,opts,ms=TIMEOUT_MS){
  const ctl = new AbortController();
  const timer = setTimeout(()=>ctl.abort(), ms);
  try { return await fetch(url,{...opts,signal:ctl.signal}); }
  finally { clearTimeout(timer); }
}

/* ── GEMINI ── */
async function _gemini(system,userMsg,maxTokens,modelo){
  const r = await fetchTO(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${getProviderKey("gemini")}`,
    { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        systemInstruction:{parts:[{text:system}]},
        contents:[{role:"user",parts:[{text:userMsg}]}],
        generationConfig:{maxOutputTokens:maxTokens,temperature:0.4}
      })});
  if(!r.ok){
    const e = await r.json().catch(()=>({}));
    const msg = e?.error?.message || ("HTTP "+r.status);
    const err = new Error("Gemini: "+msg);
    err.status=r.status; err.sinCuota=/limit:\s*0/.test(msg)||r.status===404; err.esperar=extraerEspera(msg);
    throw err;
  }
  const d = await r.json();
  const texto = (d?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("\n");
  if(!texto) throw new Error("Gemini: respuesta vacía");
  return texto;
}

/* ── OpenAI-compatible (Groq, Cerebras, Perplexity) ── */
const URL_OAI = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  cerebras: "https://api.cerebras.ai/v1/chat/completions",
  perplexity: "https://api.perplexity.ai/chat/completions"
};
async function _oai(prov,system,userMsg,maxTokens,modelo){
  const cuerpo = JSON.stringify({
    model: modelo, max_tokens: maxTokens, temperature: 0.4,
    messages:[{role:"system",content:system},{role:"user",content:userMsg}]
  });
  const headers = {"Content-Type":"application/json","Authorization":"Bearer "+getProviderKey(prov)};
  let r;
  try { r = await fetchTO(URL_OAI[prov],{method:"POST",headers,body:cuerpo}); }
  catch(errRed){
    if(errRed.name==="AbortError") { const e=new Error(prov+": timeout (no respondió en 60s)"); e.status=408; throw e; }
    // CORS/red bloqueada → intento vía proxy
    r = await fetchTO("https://corsproxy.io/?url="+encodeURIComponent(URL_OAI[prov]),{method:"POST",headers,body:cuerpo});
  }
  if(!r.ok){
    const e = await r.json().catch(()=>({}));
    const msg = e?.error?.message || e?.message || ("HTTP "+r.status);
    const err = new Error(prov+": "+msg);
    err.status=r.status; err.sinCuota=r.status===404||/model.*(not|decommission|unsupport)/i.test(msg); err.esperar=extraerEspera(msg);
    throw err;
  }
  const d = await r.json();
  const t = d?.choices?.[0]?.message?.content || "";
  if(!t) throw new Error(prov+": respuesta vacía");
  return t;
}

/* ── ANTHROPIC ── */
async function _anthropic(system,userMsg,maxTokens,modelo){
  const r = await fetchTO("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":getProviderKey("anthropic"),
      "anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
    body: JSON.stringify({model:modelo,max_tokens:maxTokens,system,messages:[{role:"user",content:userMsg}]})});
  if(!r.ok){ const e=await r.json().catch(()=>({})); const err=new Error("Anthropic: "+(e?.error?.message||"HTTP "+r.status)); err.status=r.status; throw err; }
  const d = await r.json();
  return d.content.filter(b=>b.type==="text").map(b=>b.text).join("\n");
}

/* ── Un proveedor con SU cascada de modelos y reintentos ── */
async function llamarProveedor(prov,system,userMsg,maxTokens,modeloPref){
  const P = PROVEEDORES[prov];
  const lista = modeloPref ? [modeloPref,...P.modelosCascada.filter(m=>m!==modeloPref)] : [...P.modelosCascada];
  let ultimo = null;
  for(const modelo of lista){
    for(let intento=1; intento<=2; intento++){
      await tomarTurno(prov);
      try{
        if(prov==="gemini")    return await _gemini(system,userMsg,maxTokens,modelo);
        if(prov==="anthropic") return await _anthropic(system,userMsg,maxTokens,modelo);
        return await _oai(prov,system,userMsg,maxTokens,modelo);
      }catch(e){
        ultimo = e;
        if(e.sinCuota) break;                       // este modelo no existe/sin cuota → siguiente modelo
        if(e.status===429){ await dormir(e.esperar||12000*intento); continue; }
        if(e.status>=500){ await dormir(1500*intento); continue; }
        if(e.status===408) break;                   // timeout → no insistir en este modelo
        throw e;                                    // error de key u otro → que lo maneje el failover
      }
    }
  }
  throw ultimo || new Error(prov+": sin modelos disponibles");
}

/* ── INTERFAZ UNIFICADA con FAILOVER entre proveedores ──
   Intenta el proveedor pedido; si se tuesta (error, cuota del día
   agotada, timeout, key inválida) salta al siguiente con key. */
const _quemados = {}; // proveedor → timestamp hasta el que se considera caído
async function llamarIA(proveedor,system,userMsg,maxTokens=1800,modelo=null){
  const ahora = Date.now();
  const orden = [proveedor, ...ORDEN_FAILOVER.filter(p=>p!==proveedor)]
    .filter(p=>getProviderKey(p))
    .filter(p=>!( _quemados[p] && _quemados[p]>ahora ));
  if(!orden.length){
    // todos marcados como quemados → limpiar marcas e intentar el pedido igual
    Object.keys(_quemados).forEach(k=>delete _quemados[k]);
    if(getProviderKey(proveedor)) orden.push(proveedor);
    else throw new Error("No hay proveedores con API key configurada.");
  }
  let ultimo = null;
  for(const p of orden){
    try{
      const m = (p===proveedor) ? modelo : null; // el modelo pedido solo aplica a su proveedor
      return await llamarProveedor(p,system,userMsg,maxTokens,m);
    }catch(e){
      ultimo = e;
      // marcar caído 2 min para no golpearlo en cada tarea del pool
      _quemados[p] = Date.now()+120000;
      console.warn("Failover:",p,"→ siguiente.",e.message);
    }
  }
  throw ultimo;
}

/* Pool de concurrencia */
async function poolParalelo(tareas,concurrencia,onProgreso){
  const res = new Array(tareas.length);
  let i=0, done=0;
  async function worker(){
    while(i<tareas.length){
      const k=i++;
      res[k]=await tareas[k]().catch(e=>({error:e.message}));
      done++;
      if(onProgreso) onProgreso(done,tareas.length,k,res[k]);
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrencia,tareas.length)},worker));
  return res;
}
