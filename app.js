// util
const $ = (id) => document.getElementById(id);
const asMoney = (n) =>
  (isNaN(n) ? 0 : n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/* ========= UI básico ========= */
function wireDrop(areaId, inputId, metaId, pgId) {
  const box = $(areaId), input = $(inputId), meta = $(metaId), pg = $(pgId);

  const setFilesInfo = (files) => {
    if (!files?.length) { meta.classList.add('hidden'); box.classList.remove('filled'); return; }
    box.classList.add('filled');
    meta.innerHTML = `<span class="name">${files[0].name}</span><span class="count">${files.length} arquivo(s)</span>`;
    meta.classList.remove('hidden');
  };

  box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('dragover'); });
  box.addEventListener('dragleave', () => box.classList.remove('dragover'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('dragover'); input.files = e.dataTransfer.files; setFilesInfo(input.files); });
  input.addEventListener('change', () => setFilesInfo(input.files));

  return {
    getFiles: () => input.files ? Array.from(input.files) : [],
    progress: (on) => pg.classList.toggle('hidden', !on),
    reset: () => { input.value = ''; meta.classList.add('hidden'); box.classList.remove('filled'); }
  };
}

const uiS = wireDrop('dropSintegra', 'inpSintegra', 'metaSintegra', 'pgSintegra');
const uiX = wireDrop('dropXML', 'inpXML', 'metaXML', 'pgXML');

$('btnLimpar').onclick = () => { uiS.reset(); uiX.reset(); $('msg').textContent = ''; $('cardResumo').style.display='none'; $('listResumo').innerHTML=''; };

/* ========= Parse SINTEGRA =========
 * Estratégia: aceitar .txt e .zip; procurar REGISTRO 54 (itens) ou 50 (capa).
 * Como layouts variam, usamos heurística:
 *  - Se houver registro 54: somamos campo parecido com valor do item (captura grupos numéricos grandes com vírgula)
 *  - Senão: caímos para registro 50 (valor da nota)
 *  - Tentamos classificar Entrada x Saída pelos CFOPs encontrados (1/2 = entrada, 5/6 = saída)
 * Isso cobre a maioria dos arquivos MG/SP/PR e, quando vier “zerado”, apenas retorna 0 (continua válido).
 */
async function readSintegra(files){
  const JSZipMod = window.JSZip;
  let lines = [];
  for (const f of files){
    const low = f.name.toLowerCase();
    if (low.endsWith('.zip')){
      const zip = await JSZipMod.loadAsync(f);
      for (const entry of Object.values(zip.files)){
        if (!entry.dir && entry.name.toLowerCase().endsWith('.txt')){
          const txt = await entry.async('string'); lines.push(...txt.split(/\r?\n/));
        }
      }
    } else if (low.endsWith('.txt')){
      const txt = await f.text(); lines.push(...txt.split(/\r?\n/));
    }
  }
  // normaliza
  lines = lines.map(l => l.normalize('NFC'));

  let totGeral = 0, ent=0, sai=0;
  const cfops = [];

  const moneyFrom = (s) => {
    // pega último número com vírgula/ponto na linha
    const m = s.match(/(\d{1,3}(\.\d{3})*,\d{2})/g) || s.match(/(\d+\.\d{2})/g);
    if (!m) return 0;
    const pick = m[m.length-1].replace(/\./g,'').replace(',','.');
    return parseFloat(pick)||0;
  };

  for (const raw of lines){
    const l = raw.trim();
    if (!l) continue;

    // registro 54: item
    if (l.startsWith('54')){
      const v = moneyFrom(l);
      totGeral += v;

      // tenta achar CFOP (muito comum vir “|” ou puro colado; procuramos 3/4 dígitos com começo 1,2,5,6)
      const cf = (l.match(/[^0-9](1|2|5|6)\d{2}[^0-9]/) || l.match(/\b(1|2|5|6)\d{2}\b/) || [])[0];
      if (cf){
        const n = (cf.match(/\d{3,4}/)||[''])[0];
        if (n) cfops.push(n);
      }
    }
    // registro 50: capa
    else if (l.startsWith('50')){
      const v = moneyFrom(l);
      // Só usa 50 se 54 não apareceu (evita somar duas vezes)
      // Decidimos depois, no fim
      if (v>0) totGeral += 0; // placeholder; o 50 entra se não tiver nenhum 54
      const cf = (l.match(/\b(1|2|5|6)\d{2}\b/) || [])[0];
      if (cf) cfops.push(cf);
    }
  }

  // Se não encontramos 54 com valores > 0, tenta 50
  if (totGeral === 0){
    for (const raw of lines){
      const l = raw.trim(); if (!l.startsWith('50')) continue;
      totGeral += moneyFrom(l);
    }
  }

  // Classificação por CFOP
  for (const c of cfops){
    if (/^(1|2)/.test(c)) ent += 0; // já contamos no total; aqui só marcamos classes
    if (/^(5|6)/.test(c)) sai += 0;
  }
  // Heurística de partição (quando não há itemizado): divide pelo sinal dos CFOPs
  // Se houver CFOPs de entrada/saída mistos, tenta split aproximado
  const hasEnt = cfops.some(c=>/^(1|2)/.test(c));
  const hasSai = cfops.some(c=>/^(5|6)/.test(c));
  if (hasEnt && !hasSai) { ent = totGeral; sai = 0; }
  else if (!hasEnt && hasSai) { sai = totGeral; ent = 0; }
  else if (hasEnt && hasSai) { ent = totGeral/2; sai = totGeral/2; } // melhor esforço
  else { ent = 0; sai = 0; } // sem CFOPs → deixa como geral

  return { total: totGeral, entradas: ent, saidas: sai, qtdLinhas: lines.length };
}

/* ========= Parse XMLs/ZIPs ========= */
function digits(s){ return (s||'').replace(/\D+/g,''); }
function byLocalNameAll(doc, name){
  const all = doc.getElementsByTagName('*'); const out = [];
  for (let i=0;i<all.length;i++) if ((all[i].localName||all[i].nodeName) === name) out.push(all[i]);
  return out;
}
function firstByLocalName(doc, name){ return byLocalNameAll(doc, name)[0] || null; }
function findPathLocal(root, path){
  let cur = root; for (const seg of path){
    let found = null; for (const ch of cur.children){ if ((ch.localName||ch.nodeName) === seg){ found = ch; break; } }
    if (!found) return null; cur = found;
  } return cur;
}
function pickInfNFe(doc){
  const inf = firstByLocalName(doc, 'infNFe'); if (inf) return inf;
  const nfe = firstByLocalName(doc, 'NFe'); if (nfe){ const inner = firstByLocalName(nfe,'infNFe'); return inner||nfe; }
  return doc.documentElement;
}
function parseXML(text){ return new DOMParser().parseFromString(text, 'text/xml'); }
function val(node){ return node?.textContent?.trim()||''; }

function parseOneXML(text){
  const doc = parseXML(text);
  const inf = pickInfNFe(doc);
  const nNF  = val(findPathLocal(inf, ['ide','nNF']));
  const serie= val(findPathLocal(inf, ['ide','serie']));
  const dhEmi= val(findPathLocal(inf, ['ide','dhEmi'])) || val(findPathLocal(inf, ['ide','dEmi']));
  const vNF  = parseFloat((val(findPathLocal(inf, ['total','ICMSTot','vNF']))||'0').replace(',','.'))||0;

  // classifica por CFOP do primeiro item
  let tipo = 'DESCONHECIDO';
  const det = firstByLocalName(doc, 'det');
  if (det){
    const cf = val(findPathLocal(det, ['prod','CFOP']));
    if (/^(1|2)/.test(cf)) tipo = 'ENTRADA';
    if (/^(5|6)/.test(cf)) tipo = 'SAÍDA';
  }

  return { nNF, serie, dhEmi, vNF, tipo };
}

async function readXMLs(files){
  const JSZipMod = window.JSZip;
  const items = [];
  for (const f of files){
    const low = f.name.toLowerCase();
    if (low.endsWith('.xml')){
      items.push({ name:f.name, text: await f.text() });
    } else if (low.endsWith('.zip')){
      const zip = await JSZipMod.loadAsync(f);
      for (const entry of Object.values(zip.files)){
        if (!entry.dir && entry.name.toLowerCase().endsWith('.xml')){
          const txt = await entry.async('string');
          items.push({ name: entry.name.split('/').pop(), text: txt });
        }
      }
    }
  }
  // parse
  const rows = items.map(it => parseOneXML(it.text));
  // totais
  const total = rows.reduce((a,b)=>a+b.vNF,0);
  const entradas = rows.filter(r=>r.tipo==='ENTRADA').reduce((a,b)=>a+b.vNF,0);
  const saidas   = rows.filter(r=>r.tipo==='SAÍDA').reduce((a,b)=>a+b.vNF,0);
  return { total, entradas, saidas, qtd: rows.length, rows };
}

/* ========= Comparar & Exibir ========= */
$('btnComparar').onclick = async () => {
  $('msg').textContent = '';
  $('cardResumo').style.display = 'none';

  const sinFiles = uiS.getFiles();
  const xmlFiles = uiX.getFiles();
  if (!sinFiles.length && !xmlFiles.length){
    $('msg').textContent = 'Selecione ao menos um arquivo SINTEGRA ou XML.';
    return;
  }

  try{
    uiS.progress(true); uiX.progress(true);

    const [sin, xmls] = await Promise.all([
      readSintegra(sinFiles),
      readXMLs(xmlFiles)
    ]);

    uiS.progress(false); uiX.progress(false);

    // diferença (geral e por tipo)
    const difGeral = (xmls.total||0) - (sin.total||0);
    const difEnt   = (xmls.entradas||0) - (sin.entradas||0);
    const difSai   = (xmls.saidas||0)   - (sin.saidas||0);

    // pinta
    const stat = (titulo, valor, subt='') =>
      `<div class="stat"><small>${titulo}</small><b>${asMoney(valor)}</b>${subt?`<small>${subt}</small>`:''}</div>`;

    $('stats').innerHTML = [
      stat('SINTEGRA — Total', sin.total, `Entradas: ${asMoney(sin.entradas)} • Saídas: ${asMoney(sin.saidas)}`),
      stat('FSist (XMLs) — Total', xmls.total, `Entradas: ${asMoney(xmls.entradas)} • Saídas: ${asMoney(xmls.saidas)}`),
      stat('Diferença — Geral', difGeral),
      stat('Diferença — Entradas', difEnt),
      stat('Diferença — Saídas', difSai),
    ].join('');

    $('companyInfo').textContent =
      `Arquivos processados — SINTEGRA: ${sinFiles.length} arquivo(s) • linhas: ${sin.qtdLinhas} · XML: ${xmls.qtd} nota(s)`;
    $('cardResumo').style.display = '';

    // opcional: lista enxuta
    const resumoTable = `
      <div style="overflow:auto">
        <table>
          <thead><tr><th>Origem</th><th>Tipo</th><th>Série</th><th>NF</th><th>Emissão</th><th>Valor</th></tr></thead>
          <tbody>
            ${xmls.rows.slice(0,200).map(r=>`<tr><td>XML</td><td>${r.tipo}</td><td>${r.serie}</td><td>${r.nNF}</td><td>${r.dhEmi||''}</td><td>${asMoney(r.vNF)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    $('listResumo').innerHTML = resumoTable;
    $('cardListas').classList.remove('hidden');

  } catch(err){
    console.error(err);
    $('msg').textContent = 'Erro ao processar. Verifique os arquivos.';
    uiS.progress(false); uiX.progress(false);
  }
};
