// ===== Comparador de Notas de Entrada (client-side) — compara, gera relatórios e visualiza DANFE =====

const el = id => document.getElementById(id);

// ---------- Helpers XML ----------
function digits(s){ return (s||'').replace(/\D+/g,''); }
function byLocalNameAll(doc, name){
  const all = doc.getElementsByTagName('*');
  const out = [];
  for (let i=0;i<all.length;i++){ if ((all[i].localName||all[i].nodeName) === name) out.push(all[i]); }
  return out;
}
function firstByLocalName(doc, name){ return byLocalNameAll(doc, name)[0] || null; }

// Caminha por localName (independe de namespace)
function findPathLocal(root, path){
  let cur = root;
  for (const seg of path){
    let found = null;
    for (const ch of cur.children){
      if ((ch.localName||ch.nodeName) === seg){ found = ch; break; }
    }
    if (!found) return null;
    cur = found;
  }
  return cur;
}

function pickInfNFe(doc){
  const inf = firstByLocalName(doc, 'infNFe');
  if (inf) return inf;
  const nfe = firstByLocalName(doc, 'NFe');
  if (nfe){
    const inner = firstByLocalName(nfe, 'infNFe');
    if (inner) return inner;
    return nfe;
  }
  return doc.documentElement;
}

function parseXML(text){ return new DOMParser().parseFromString(text, 'text/xml'); }

// chave: chNFe (infProt) > Id de infNFe > fallback emitDoc-serie-nNF
function getAccessKey(doc){
  const infProt = firstByLocalName(doc, 'infProt');
  if (infProt){
    const ch = findPathLocal(infProt, ['chNFe']);
    if (ch && ch.textContent) return digits(ch.textContent);
  }
  const inf = pickInfNFe(doc);
  if (inf && inf.getAttribute && inf.getAttribute('Id')){
    const v = inf.getAttribute('Id');
    if (v && v.toUpperCase().startsWith('NFE')) return digits(v);
  }
  const emitDoc = (findPathLocal(inf, ['emit','CNPJ']) || findPathLocal(inf, ['emit','CPF']));
  const serie   = findPathLocal(inf, ['ide','serie']);
  const nNF     = findPathLocal(inf, ['ide','nNF']);
  return `${digits(emitDoc?.textContent||'')}-${digits(serie?.textContent||'')}-${digits(nNF?.textContent||'')}`;
}

function extractParty(inf, which){
  const base = which==='dest' ? 'dest' : 'emit';
  const name = findPathLocal(inf, [base,'xNome']);
  const docn = findPathLocal(inf, [base,'CNPJ']) || findPathLocal(inf, [base,'CPF']);
  return { name: (name?.textContent||'DESCONHECIDO'), doc: digits(docn?.textContent||'') };
}

function parseUF(inf, which){
  const base = which==='dest' ? 'dest' : 'emit';
  // enderEmit / enderDest
  const uf = findPathLocal(inf, [base, 'ender' + (base==='emit'?'Emit':'Dest'), 'UF'])?.textContent || '';
  return (uf||'').trim().toUpperCase();
}

function extractBasics(doc){
  const inf = pickInfNFe(doc);
  const key = getAccessKey(doc);
  const nNF = findPathLocal(inf, ['ide','nNF'])?.textContent || '';
  const serie = findPathLocal(inf, ['ide','serie'])?.textContent || '';
  const dhEmi = (findPathLocal(inf, ['ide','dhEmi'])?.textContent || findPathLocal(inf, ['ide','dEmi'])?.textContent || '');
  const vNF  = findPathLocal(inf, ['total','ICMSTot','vNF'])?.textContent || '';
  const emit = extractParty(inf, 'emit');
  const dest = extractParty(inf, 'dest');
  const ufEmit = parseUF(inf, 'emit');
  const ufDest = parseUF(inf, 'dest');
  // itens (para DANFE)
  const dets = byLocalNameAll(inf, 'det').map(d=>{
    const prod = firstByLocalName(d, 'prod');
    const xProd = findPathLocal(prod, ['xProd'])?.textContent || '';
    const CFOP  = findPathLocal(prod, ['CFOP'])?.textContent || '';
    const qCom  = findPathLocal(prod, ['qCom'])?.textContent || '';
    const vProd = findPathLocal(prod, ['vProd'])?.textContent || '';
    const uCom  = findPathLocal(prod, ['uCom'])?.textContent || '';
    return { xProd, CFOP, qCom, vProd, uCom };
  });
  return { key, nNF, serie, dhEmi, vNF, emit, dest, ufEmit, ufDest, dets };
}

// Carrega ZIPs e XMLs soltos
async function collectXMLs(fileList){
  const items = [];
  for (const file of fileList){
    const low = file.name.toLowerCase();
    if (low.endsWith('.xml')){
      items.push({name:file.name, text: await file.text()});
    } else if (low.endsWith('.zip')) {
      const zip = await JSZip.loadAsync(file);
      for (const entry of Object.values(zip.files)){
        if (!entry.dir && entry.name.toLowerCase().endsWith('.xml')){
          const txt = await entry.async('string');
          const base = entry.name.split('/').pop();
          items.push({name: base, text: txt});
        }
      }
    }
  }
  return items;
}

// Tabela HTML
function tableFromRows(header, rows){
  const thead = `<thead><tr>${header.map(h=>`<th>${h}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c??""}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<div style="overflow:auto"><table>${thead}${tbody}</table></div>`;
}

// Excel (detalhado)
function buildExcelDetailed(commonRows, diffRows){
  const wb = XLSX.utils.book_new();
  const cols = ["chave","nNF","série","emissão","valor","emitente","emitente_doc","UF_emit","destinatário","dest_doc","UF_dest","origem"];
  const ws1 = XLSX.utils.aoa_to_sheet([cols, ...commonRows]);
  const ws2 = XLSX.utils.aoa_to_sheet([cols, ...diffRows]);
  XLSX.utils.book_append_sheet(wb, ws1, "em_comum");
  XLSX.utils.book_append_sheet(wb, ws2, "diferentes");
  const wbout = XLSX.write(wb, {bookType:"xlsx", type:"array"});
  return new Blob([wbout], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}

// Relatório detalhado (HTML standalone para enviar ao cliente)
function buildClientHTMLReport(meta, commonRows, diffRows){
  const css = `
    body{font-family:Segoe UI,Tahoma,Roboto,Arial,sans-serif;color:#333;margin:20px}
    h1,h2,h3{color:#8B0000;margin:6px 0}
    .grid{display:grid;gap:10px;grid-template-columns:repeat(5,minmax(160px,1fr))}
    .stat{border:1px solid #ddd;padding:10px;border-radius:8px;text-align:center}
    table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
    th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}
    th{background:#8B0000;color:#fff}
    .muted{color:#555}
    .section{margin:18px 0}
    .small{font-size:12px;color:#666}
  `;
  const header = ["Chave","nNF","Série","Emissão","Valor","Emitente","Emitente doc","UF emit","Destinatário","Dest doc","UF dest","Origem"];
  const tbl = (title, rows)=>`
    <div class="section">
      <h3>${title}</h3>
      <table>
        <thead><tr>${header.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c??""}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>
  `;
  const html = `
<!doctype html><html><head><meta charset="utf-8"><title>Relatório — ${meta.companyName}</title>
<style>${css}</style></head><body>
  <h1>Relatório de Conferência — ${meta.companyName}</h1>
  <p class="small">Período/Lote: ${meta.period||'-'} — Gerado em ${new Date().toLocaleString()}</p>
  <div class="grid">
    <div class="stat">Destinatário<br><strong>${meta.companyName} — ${meta.companyDoc}</strong></div>
    <div class="stat">Totais EMPRESA<br><strong>${meta.totA}</strong></div>
    <div class="stat">Totais FSIST<br><strong>${meta.totB}</strong></div>
    <div class="stat">Em comum<br><strong>${meta.totCommon}</strong></div>
    <div class="stat">Diferentes<br><strong>${meta.totDiff}</strong></div>
  </div>
  ${tbl("Notas em comum", commonRows)}
  ${tbl("Notas diferentes", diffRows)}
  <p class="muted small">Observação: “Notas diferentes” incluem notas presentes apenas em um dos lados (EMPRESA ou FSIST). Recomenda-se validação junto ao cliente para notas somente FSIST.</p>
</body></html>`;
  return new Blob([html], {type:"text/html;charset=utf-8"});
}

// ---------- Comparação ----------
async function compareSets(filesA, filesB){
  const warn = el('warn'); warn.textContent = "";

  const A = await collectXMLs(filesA);
  const B = await collectXMLs(filesB);
  if (A.length===0 || B.length===0){ warn.textContent = "Selecione arquivos para os dois lados."; return null; }

  function mapSet(arr, origin){
    const parsed = [];
    const destDocs = new Set();
    for (const item of arr){
      try{
        const doc = parseXML(item.text);
        const b = extractBasics(doc);
        parsed.push({ ...b, origin, filename:item.name, raw:item.text });
        if (b.dest.doc) destDocs.add(b.dest.doc);
      }catch{/* ignora arquivo inválido */}
    }
    return { parsed, destDocs };
  }

  const left  = mapSet(A, "EMPRESA");
  const right = mapSet(B, "FSIST");

  const leftDocs  = Array.from(left.destDocs);
  const rightDocs = Array.from(right.destDocs);

  // Mesma empresa (destinatário) nos dois lados?
  if (leftDocs.length!==1 || rightDocs.length!==1 || leftDocs[0]!==rightDocs[0]){
    const info = `Destinatários detectados — EMPRESA: ${leftDocs.join(',')||'n/d'}; FSIST: ${rightDocs.join(',')||'n/d'}`;
    warn.textContent = "Empresas distintas ou não identificadas. " + info;
    el('summary').classList.add('hidden');
    return null;
  }

  // Mapas por chave (dedupe dentro de cada lado)
  const mapA = new Map(), mapB = new Map();
  for (const x of left.parsed)  if (!mapA.has(x.key)) mapA.set(x.key, x);
  for (const x of right.parsed) if (!mapB.has(x.key)) mapB.set(x.key, x);

  const commonKeys = [];
  const onlyA = [];
  const onlyB = [];
  for (const [k] of mapA){ if (mapB.has(k)) commonKeys.push(k); else onlyA.push(k); }
  for (const [k] of mapB){ if (!mapA.has(k)) onlyB.push(k); }

  // Linhas (detalhadas)
  const toRow = (x, origin) => [x.key, x.nNF, x.serie, x.dhEmi, x.vNF, x.emit.name, x.emit.doc, x.ufEmit, x.dest.name, x.dest.doc, x.ufDest, origin];
  const common = commonKeys.map(k => toRow(mapA.get(k) || mapB.get(k), "COMUM"));
  const diff   = [
    ...onlyA.map(k => toRow(mapA.get(k), "SOMENTE_EMPRESA")),
    ...onlyB.map(k => toRow(mapB.get(k), "SOMENTE_FSIST"))
  ];

  // ---------- UI ----------
  el('summary').classList.remove('hidden');
  el('stats').innerHTML = `
    <div class="stat">Empresa<br><strong>${left.parsed[0].dest.name} — ${leftDocs[0]}</strong></div>
    <div class="stat">Totais EMPRESA<br><strong>${mapA.size}</strong></div>
    <div class="stat">Totais FSIST<br><strong>${mapB.size}</strong></div>
    <div class="stat">Em comum<br><strong>${commonKeys.length}</strong></div>
    <div class="stat">Diferentes<br><strong>${onlyA.length + onlyB.length}</strong></div>
  `;
  el('companyInfo').textContent = `Destinatário validado: ${left.parsed[0].dest.name} — ${leftDocs[0]}`;

  const headers = ["Chave","nNF","Série","Emissão","Valor","Emitente","Emitente doc","UF emit","Destinatário","Dest doc","UF dest","Origem"];
  el('tableCommon').innerHTML = tableFromRows(headers, common);
  el('tableDiff').innerHTML   = tableFromRows(headers, diff);

  // ---------- Downloads e ações ----------
  const dlCommon = el('dlCommon'), dlDiff = el('dlDiff'), dlExcel = el('dlExcel');
  const viewDiffBtn = el('viewDiffBtn');
  const dlHTML = el('dlHTML');

  dlCommon.disabled = dlDiff.disabled = dlExcel.disabled = viewDiffBtn.disabled = dlHTML.disabled = false;

  // ZIPs
  async function buildCommonZip(){
    const zip = new JSZip();
    for (const k of commonKeys){
      const a = mapA.get(k) || mapB.get(k);
      zip.file(`comum/${a.filename}`, a.raw);
    }
    return await zip.generateAsync({type:'blob'});
  }
  async function buildDiffZip(){
    const zip = new JSZip();
    for (const k of onlyA){ const a = mapA.get(k); zip.file(`diferentes/SOMENTE_EMPRESA/${a.filename}`, a.raw); }
    for (const k of onlyB){ const b = mapB.get(k); zip.file(`diferentes/SOMENTE_FSIST/${b.filename}`, b.raw); }
    return await zip.generateAsync({type:'blob'});
  }

  dlCommon.onclick = async ()=>{
    dlCommon.disabled = true; dlCommon.textContent = "Gerando...";
    try { saveAs(await buildCommonZip(), "comparativo-comum.zip"); }
    finally { dlCommon.disabled = false; dlCommon.textContent = "Notas em comum (ZIP)"; }
  };
  dlDiff.onclick = async ()=>{
    dlDiff.disabled = true; dlDiff.textContent = "Gerando...";
    try { saveAs(await buildDiffZip(), "comparativo-diferentes.zip"); }
    finally { dlDiff.disabled = false; dlDiff.textContent = "Notas diferentes (ZIP)"; }
  };
  dlExcel.onclick = async ()=>{
    dlExcel.disabled = true; dlExcel.textContent = "Gerando...";
    try { saveAs(buildExcelDetailed(common, diff), "relatorio_comparativo.xlsx"); }
    finally { dlExcel.disabled = false; dlExcel.textContent = "Relatório comparativo (Excel)"; }
  };

  // Relatório detalhado (HTML) p/ cliente
  dlHTML.onclick = async ()=>{
    dlHTML.disabled = true; dlHTML.textContent = "Gerando...";
    try {
      const meta = {
        companyName: left.parsed[0].dest.name,
        companyDoc: leftDocs[0],
        period: "",
        totA: mapA.size, totB: mapB.size,
        totCommon: commonKeys.length, totDiff: onlyA.length + onlyB.length
      };
      const blob = buildClientHTMLReport(meta, common, diff);
      saveAs(blob, "relatorio_detalhado.html");
    } finally {
      dlHTML.disabled = false; dlHTML.textContent = "Relatório detalhado (HTML)"; }
  };

  // Guardar contexto para DANFE
  window.__cmp = { left, right, mapA, mapB, onlyA, onlyB, diffRows: diff };

  return {common, diff};
}

// ---------- Visualização de DANFE (básica, legível/printável) ----------
function danfeHTML(x){
  const fmt = (n)=> (n||"").toString();
  const itens = (x.dets||[]).map((d,i)=>`
    <tr><td>${i+1}</td><td>${d.xProd||''}</td><td>${d.CFOP||''}</td><td>${d.uCom||''}</td><td style="text-align:right">${d.qCom||''}</td><td style="text-align:right">${d.vProd||''}</td></tr>
  `).join('');
  const css = `
    body{font-family:Segoe UI,Tahoma,Roboto,Arial,sans-serif;color:#222;margin:20px}
    h1,h2{margin:6px 0}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .box{border:1px solid #ddd;border-radius:8px;padding:10px}
    table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
    th,td{border-bottom:1px solid #eee;padding:6px;text-align:left}
    th{background:#f6f6f6}
    .right{text-align:right}
    .muted{color:#666;font-size:12px}
  `;
  return `
<!doctype html><html><head><meta charset="utf-8"><title>DANFE — ${x.key}</title><style>${css}</style></head>
<body>
  <h1>DANFE (visualização)</h1>
  <p class="muted">Representação simplificada para conferência/ impressão.</p>
  <div class="grid">
    <div class="box">
      <h2>Emitente</h2>
      <div>${fmt(x.emit.name)} — ${fmt(x.emit.doc)} (UF: ${fmt(x.ufEmit)})</div>
    </div>
    <div class="box">
      <h2>Destinatário</h2>
      <div>${fmt(x.dest.name)} — ${fmt(x.dest.doc)} (UF: ${fmt(x.ufDest)})</div>
    </div>
  </div>

  <div class="box" style="margin-top:10px">
    <strong>Chave:</strong> ${fmt(x.key)} &nbsp; | &nbsp;
    <strong>NF:</strong> ${fmt(x.nNF)} &nbsp; | &nbsp;
    <strong>Série:</strong> ${fmt(x.serie)} &nbsp; | &nbsp;
    <strong>Emissão:</strong> ${fmt(x.dhEmi)} &nbsp; | &nbsp;
    <strong>Valor Total:</strong> R$ ${fmt(x.vNF)}
  </div>

  <div class="box" style="margin-top:10px">
    <h2>Itens</h2>
    <table>
      <thead><tr><th>#</th><th>Descrição</th><th>CFOP</th><th>Un</th><th class="right">Qtd</th><th class="right">Valor</th></tr></thead>
      <tbody>${itens || `<tr><td colspan="6" class="muted">Itens não informados no XML.</td></tr>`}</tbody>
    </table>
  </div>
</body></html>`;
}

// Abre nova aba com HTML gerado
function openDANFEWindow(x){
  const w = window.open("", "_blank");
  if (!w){ alert("Permita pop-ups para visualizar o DANFE."); return; }
  w.document.open();
  w.document.write(danfeHTML(x));
  w.document.close();
}

// Monta lista em modal com as notas diferentes e botões “Abrir DANFE”
function showDanfeModal(){
  const modal = el('danfeModal');
  const listEl = el('danfeList');
  const { mapA, mapB, onlyA, onlyB } = (window.__cmp || {});
  if (!mapA || !mapB){ alert("Faça a comparação primeiro."); return; }

  const cards = [];

  for (const k of onlyA){
    const x = mapA.get(k);
    cards.push(`
      <div class="danfe-card">
        <h4>SOMENTE_EMPRESA — Chave ${x.key}</h4>
        <div class="meta"><span>NF: ${x.nNF}</span><span>Série: ${x.serie}</span><span>Emissão: ${x.dhEmi}</span><span>Valor: R$ ${x.vNF}</span></div>
        <div class="row">
          <button class="btn primary" data-key="${x.key}" data-side="A">Abrir DANFE</button>
          <a class="btn secondary" target="_blank" rel="noopener" href="https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?tipoConsulta=resumo&tipoConteudo=7PhJ+gAVw2g%3D">Consultar na SEFAZ</a>
        </div>
      </div>
    `);
  }
  for (const k of onlyB){
    const x = mapB.get(k);
    cards.push(`
      <div class="danfe-card">
        <h4>SOMENTE_FSIST — Chave ${x.key}</h4>
        <div class="meta"><span>NF: ${x.nNF}</span><span>Série: ${x.serie}</span><span>Emissão: ${x.dhEmi}</span><span>Valor: R$ ${x.vNF}</span></div>
        <div class="row">
          <button class="btn primary" data-key="${x.key}" data-side="B">Abrir DANFE</button>
          <a class="btn secondary" target="_blank" rel="noopener" href="https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?tipoConsulta=resumo&tipoConteudo=7PhJ+gAVw2g%3D">Consultar na SEFAZ</a>
        </div>
      </div>
    `);
  }

  listEl.innerHTML = `<div class="danfe-list">${cards.join('') || '<p>Nenhuma nota diferente encontrada.</p>'}</div>`;
  modal.classList.remove('hidden');

  // Delegação para botões Abrir DANFE
  listEl.querySelectorAll('button[data-key]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const side = btn.getAttribute('data-side');
      const key = btn.getAttribute('data-key');
      const x = side==='A' ? (window.__cmp.mapA.get(key)) : (window.__cmp.mapB.get(key));
      openDANFEWindow(x);
    });
  });
}

// ---------- Upload UI (nomes com reticências, +N, arrastar/soltar) ----------
function wireUploadUI(labelEl, inputEl, titulo){
  function refresh(){
    const span = labelEl.querySelector('span');
    const list = Array.from(inputEl.files || []);
    if (!span) return;

    if (list.length === 0){
      labelEl.classList.remove('filled');
      span.innerHTML = `<strong>${titulo}</strong><br><small>Arraste ZIP/XML aqui ou clique</small>`;
      return;
    }
    const first = list[0]?.name || "arquivo";
    const extra = Math.max(0, list.length - 1);
    const tooltip = list.slice(0,5).map(f=>f.name).join('\n') + (list.length>5 ? `\n+${list.length-5} mais...` : '');

    span.innerHTML = `
      <strong>${titulo}</strong><br>
      <small>${list.length === 1 ? '1 arquivo selecionado' : list.length + ' arquivos selecionados'}</small>
      <div class="file-meta">
        <span class="name" title="${tooltip.replace(/"/g,'&quot;')}">${first}</span>
        ${extra>0 ? `<span class="count">+${extra}</span>` : ``}
      </div>
    `;
    labelEl.classList.add('filled','anim');
    setTimeout(()=> labelEl.classList.remove('anim'), 220);
  }

  inputEl.addEventListener('change', refresh);
  ['dragenter','dragover'].forEach(ev=>{
    labelEl.addEventListener(ev, e=>{ e.preventDefault(); labelEl.classList.add('dragover'); });
  });
  ['dragleave','drop'].forEach(ev=>{
    labelEl.addEventListener(ev, e=>{ e.preventDefault(); labelEl.classList.remove('dragover'); });
  });
  labelEl.addEventListener('drop', e=>{
    e.preventDefault();
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length){
      inputEl.files = dt.files;
      refresh();
    }
  });
}

document.addEventListener('DOMContentLoaded', ()=>{
  const filesA = el('filesA');
  const filesB = el('filesB');
  const compareBtn = el('compareBtn');
  const resetBtn = el('resetBtn');
  const viewDiffBtn = el('viewDiffBtn');
  const closeDanfe = el('closeDanfe');

  // Upload UI
  wireUploadUI(document.getElementById('boxA'), filesA, 'NOTAS DA EMPRESA');
  wireUploadUI(document.getElementById('boxB'), filesB, 'NOTAS DO FSIST');

  compareBtn.addEventListener('click', async ()=>{
    compareBtn.disabled = true; compareBtn.textContent = "Comparando...";
    try { await compareSets(filesA.files, filesB.files); }
    catch(e){ console.error(e); alert(e.message||"Erro ao comparar."); }
    finally { compareBtn.disabled = false; compareBtn.textContent = "Comparar"; }
  });

  resetBtn.addEventListener('click', ()=>{
    filesA.value = ""; filesB.value = "";
    el('warn').textContent = "";
    el('summary').classList.add('hidden');

    // reset upload boxes
    ['boxA','boxB'].forEach(id=>{
      const labelEl = document.getElementById(id);
      const span = labelEl.querySelector('span');
      labelEl.classList.remove('filled','dragover','anim');
      if (id==='boxA'){
        span.innerHTML = '<strong>NOTAS DA EMPRESA</strong><br><small>Arraste ZIP/XML aqui ou clique</small>';
      }else{
        span.innerHTML = '<strong>NOTAS DO FSIST</strong><br><small>Arraste ZIP/XML aqui ou clique</small>';
      }
    });
  });

  // Modal DANFE
  viewDiffBtn.addEventListener('click', ()=>{
    if (!window.__cmp){ alert("Faça a comparação primeiro."); return; }
    showDanfeModal();
  });
  closeDanfe.addEventListener('click', ()=> el('danfeModal').classList.add('hidden'));
  el('danfeModal').addEventListener('click', (e)=>{ if (e.target.id==='danfeModal') e.currentTarget.classList.add('hidden'); });
});
