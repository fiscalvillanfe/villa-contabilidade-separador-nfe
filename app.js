// ===== Comparador de Notas de Entrada (client-side) — FIX: ignora namespaces e valida destinatário =====

const el = id => document.getElementById(id);

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

function extractBasics(doc){
  const inf = pickInfNFe(doc);
  const key = getAccessKey(doc);
  const nNF = findPathLocal(inf, ['ide','nNF'])?.textContent || '';
  const serie = findPathLocal(inf, ['ide','serie'])?.textContent || '';
  const dhEmi = (findPathLocal(inf, ['ide','dhEmi'])?.textContent || findPathLocal(inf, ['ide','dEmi'])?.textContent || '');
  const vNF  = findPathLocal(inf, ['total','ICMSTot','vNF'])?.textContent || '';
  const emit = extractParty(inf, 'emit');
  const dest = extractParty(inf, 'dest');
  return { key, nNF, serie, dhEmi, vNF, emit, dest };
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

// Excel com 2 abas
function buildExcel(commonRows, diffRows){
  const wb = XLSX.utils.book_new();
  const cols = ["chave","nNF","série","emissão","valor","emitente","emitente_doc","destinatário","dest_doc","origem"];
  const ws1 = XLSX.utils.aoa_to_sheet([cols, ...commonRows]);
  const ws2 = XLSX.utils.aoa_to_sheet([cols, ...diffRows]);
  XLSX.utils.book_append_sheet(wb, ws1, "em_comum");
  XLSX.utils.book_append_sheet(wb, ws2, "diferentes");
  const wbout = XLSX.write(wb, {bookType:"xlsx", type:"array"});
  return new Blob([wbout], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}

// Comparação
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

  const toRow = (x, origin) => [x.key, x.nNF, x.serie, x.dhEmi, x.vNF, x.emit.name, x.emit.doc, x.dest.name, x.dest.doc, origin];
  const common = commonKeys.map(k => toRow(mapA.get(k) || mapB.get(k), "COMUM"));
  const diff   = [
    ...onlyA.map(k => toRow(mapA.get(k), "SOMENTE_EMPRESA")),
    ...onlyB.map(k => toRow(mapB.get(k), "SOMENTE_FSIST"))
  ];

  // Zips
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

  // UI
  el('summary').classList.remove('hidden');
  el('stats').innerHTML = `
    <div class="stat">Empresa<br><strong>${left.parsed[0].dest.name} — ${leftDocs[0]}</strong></div>
    <div class="stat">Totais EMPRESA<br><strong>${mapA.size}</strong></div>
    <div class="stat">Totais FSIST<br><strong>${mapB.size}</strong></div>
    <div class="stat">Em comum<br><strong>${commonKeys.length}</strong></div>
    <div class="stat">Diferentes<br><strong>${onlyA.length + onlyB.length}</strong></div>
  `;
  el('companyInfo').textContent = `Destinatário validado: ${left.parsed[0].dest.name} — ${leftDocs[0]}`;

  el('tableCommon').innerHTML = tableFromRows(
    ["Chave","nNF","Série","Emissão","Valor","Emitente","Emitente doc","Destinatário","Dest doc","Origem"],
    common
  );
  el('tableDiff').innerHTML = tableFromRows(
    ["Chave","nNF","Série","Emissão","Valor","Emitente","Emitente doc","Destinatário","Dest doc","Origem"],
    diff
  );

  const dlCommon = el('dlCommon'), dlDiff = el('dlDiff'), dlExcel = el('dlExcel');
  dlCommon.disabled = dlDiff.disabled = dlExcel.disabled = false;

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
    try { saveAs(buildExcel(common, diff), "relatorio_comparativo.xlsx"); }
    finally { dlExcel.disabled = false; dlExcel.textContent = "Download de relatório comparativo (Excel)"; }
  };

  return {common, diff};
}

document.addEventListener('DOMContentLoaded', ()=>{
  const filesA = el('filesA');
  const filesB = el('filesB');
  const compareBtn = el('compareBtn');
  const resetBtn = el('resetBtn');

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
  });
});
