// ===== Comparador de Notas de Entrada — com PDF de "Notas Diferentes" =====

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
  return { key, nNF, serie, dhEmi, vNF, emit, dest, ufEmit, ufDest };
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

// Excel detalhado
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

// ---------- PDF (somente notas diferentes, sem chave) ----------
function openClientPDFPreview(meta, diffRows){
  // diffRows: [key,nNF,serie,dhEmi,vNF,emitName,emitDoc,UF_emit,destName,destDoc,UF_dest,origin]
  const rows = diffRows.map(r=>{
    const nNF=r[1]||'', serie=r[2]||'', emissao=r[3]||'', valor=r[4]||'';
    const emitName=r[5]||'', emitDoc=r[6]||'';
    const destName=r[8]||'', destDoc=r[9]||'';
    const origem=r[11]||'';
    return { nNF, serie, emissao, valor, emitName, emitDoc, destName, destDoc, origem };
  });

  const css = `
  @page { margin: 20mm; }
  :root{ --primary:#8B0000; --muted:#666; }
  body{ font-family:Segoe UI, Tahoma, Roboto, Arial, sans-serif; color:#222; }
  header{ display:flex; align-items:center; gap:12px; margin-bottom:10px; }
  header img{ width:36px; height:36px; border-radius:8px; }
  header .title{ font-size:20px; font-weight:700; color:var(--primary); }
  .meta{ font-size:12px; color:var(--muted); margin-bottom:8px; }
  .badge{ display:inline-block; padding:2px 8px; border-radius:999px; background:#f6e9ea; color:#7a1a1a; border:1px solid #e2bcbc; font-size:11px; }
  table{ width:100%; border-collapse:collapse; font-size:12px; }
  thead{ display: table-header-group; }
  tfoot{ display: table-row-group; }
  tr{ page-break-inside: avoid; }
  th,td{ border-bottom:1px solid #eee; padding:6px 6px; text-align:left; }
  th{ background:var(--primary); color:#fff; }
  td.num{ text-align:right; }
  .section-title{ margin:14px 0 6px; color:var(--primary); font-weight:700; }
  `;

  const headerCols = ['NF','Série','Emissão','Valor (R$)','Emitente','Documento','Destinatário','Documento','Origem'];
  const bodyRows = rows.map(r=>`
    <tr>
      <td>${r.nNF}</td>
      <td>${r.serie}</td>
      <td>${r.emissao}</td>
      <td class="num">${r.valor}</td>
      <td>${r.emitName}</td>
      <td>${r.emitDoc}</td>
      <td>${r.destName}</td>
      <td>${r.destDoc}</td>
      <td>${r.origem==='SOMENTE_EMPRESA'?'EMPRESA':'FSIST'}</td>
    </tr>
  `).join('');

  const html = `
<!doctype html><html><head><meta charset="utf-8">
  <title>Relatório — Notas Diferentes</title>
  <style>${css}</style>
</head><body>
  <header>
    <img src="https://i.imgur.com/kVJgNMN.png" alt="Logo">
    <div class="title">Relatório de Conferência — Notas Diferentes</div>
  </header>
  <div class="meta">
    Empresa (destinatário): <strong>${meta.companyName}</strong> — ${meta.companyDoc}<br>
    Gerado em: ${new Date().toLocaleString()} &nbsp;•&nbsp;
    Total de notas diferentes: <strong>${rows.length}</strong>
  </div>

  <div class="section-title">Notas para conferência do cliente</div>
  <table>
    <thead><tr>${headerCols.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${bodyRows || `<tr><td colspan="9">Não há notas diferentes.</td></tr>`}</tbody>
  </table>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w){ alert('Permita pop-ups para visualizar o PDF.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
  // abrir diálogo de impressão (o usuário escolhe "Salvar como PDF")
  setTimeout(()=>{ try{ w.focus(); w.print(); }catch(_){} }, 400);
}

// ---------- Comparação ----------
async function compareSets(filesA, filesB){
  const warn = el('warn'); warn.textContent = "";
  el('progressBar').classList.remove('hidden');

  const A = await collectXMLs(filesA);
  const B = await collectXMLs(filesB);
  if (A.length===0 || B.length===0){
    el('progressBar').classList.add('hidden');
    warn.textContent = "Selecione arquivos para os dois lados.";
    return null;
  }

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
    el('progressBar').classList.add('hidden');
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

  const dlCommon = el('dlCommon'), dlDiff = el('dlDiff'), dlExcel = el('dlExcel');
  const viewDiffBtn = el('viewDiffBtn');
  const dlPDF = el('dlPDF');

  dlCommon.disabled = dlDiff.disabled = dlExcel.disabled = viewDiffBtn.disabled = dlPDF.disabled = false;

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

  // PDF (somente diferentes, sem chave)
  dlPDF.onclick = ()=>{
    const meta = {
      companyName: left.parsed[0].dest.name,
      companyDoc: leftDocs[0]
    };
    openClientPDFPreview(meta, diff);
  };

  // Guardar contexto para DANFE
  window.__cmp = { left, right, mapA, mapB, onlyA, onlyB, diffRows: diff };

  el('progressBar').classList.add('hidden');
  return {common, diff};
}

// ---------- DANFE (igual de antes) ----------
function danfeHTML(x){
  const fmt = (n)=> (n||"").toString();
  const itens = []; // simplificado
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
    <div class="box"><h2>Emitente</h2><div>${fmt(x.emit.name)} — ${fmt(x.emit.doc)} (UF: ${fmt(x.ufEmit)})</div></div>
    <div class="box"><h2>Destinatário</h2><div>${fmt(x.dest.name)} — ${fmt(x.dest.doc)} (UF: ${fmt(x.ufDest)})</div></div>
  </div>
  <div class="box" style="margin-top:10px">
    <strong>NF:</strong> ${fmt(x.nNF)} &nbsp; | &nbsp;
    <strong>Série:</strong> ${fmt(x.serie)} &nbsp; | &nbsp;
    <strong>Emissão:</strong> ${fmt(x.dhEmi)} &nbsp; | &nbsp;
    <strong>Valor Total:</strong> R$ ${fmt(x.vNF)}
  </div>
  <div class="box" style="margin-top:10px">
    <h2>Itens</h2>
    <table>
      <thead><tr><th>#</th><th>Descrição</th><th>CFOP</th><th>Un</th><th class="right">Qtd</th><th class="right">Valor</th></tr></thead>
      <tbody>${itens.join('') || `<tr><td colspan="6" class="muted">Itens não informados no XML.</td></tr>`}</tbody>
    </table>
  </div>
</body></html>`;
}
function openDANFEWindow(x){
  const w = window.open("", "_blank");
  if (!w){ alert("Permita pop-ups para visualizar o DANFE."); return; }
  w.document.open();
  w.document.write(danfeHTML(x));
  w.document.close();
}
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

  listEl.querySelectorAll('button[data-key]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const side = btn.getAttribute('data-side');
      const key = btn.getAttribute('data-key');
      const x = side==='A' ? (window.__cmp.mapA.get(key)) : (window.__cmp.mapB.get(key));
      openDANFEWindow(x);
    });
  });
}

// ---------- Upload UI ----------
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
    ['boxA','boxB'].forEach(id=>{
      const labelEl = document.getElementById(id);
      const span = labelEl.querySelector('span');
      labelEl.classList.remove('filled','dragover','anim');
      span.innerHTML = (id==='boxA')
        ? '<strong>NOTAS DA EMPRESA</strong><br><small>Arraste ZIP/XML aqui ou clique</small>'
        : '<strong>NOTAS DO FSIST</strong><br><small>Arraste ZIP/XML aqui ou clique</small>';
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
