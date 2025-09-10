// ===== Comparador de Notas de Entrada — com DANFE Pro e PDF do cliente =====

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

// Itens do XML (det/prod)
function extractItems(inf){
  const dets = byLocalNameAll(inf, 'det');
  const rows = [];
  for (const d of dets){
    const prod = findPathLocal(d, ['prod']);
    if (!prod) continue;
    const xProd = findPathLocal(prod, ['xProd'])?.textContent || '';
    const CFOP  = findPathLocal(prod, ['CFOP'])?.textContent || '';
    const uCom  = findPathLocal(prod, ['uCom'])?.textContent || '';
    const qCom  = findPathLocal(prod, ['qCom'])?.textContent || '';
    const vProd = findPathLocal(prod, ['vProd'])?.textContent || '';
    rows.push({ xProd, CFOP, uCom, qCom, vProd });
  }
  return rows;
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
  const dets = extractItems(inf);
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

// Tabela HTML para a tela
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
  table{ width:100%; border-collapse:collapse; font-size:12px; }
  thead{ display: table-header-group; }
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
    <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAYAAACLz2ctAABckklEQVR4nOy9Z5Rd13Um+J1zbnipqgBUIRJEIBEIkCAJMIhBjEqWZLtbsiyNOkiy2+215sfMLM94fow1P2bWst1/PD9mrRnPWm6Ne+yeWe0ktyVbbsu2AhUs0hJzjmAEAVShqlD10r33hFl7n3vvu1X1CqgqFAIpH/DyvXrv3XTuPjt+e+8A/zSGjv/jwbv+tXDiCxbubgD14nMBwMLBwPF7JwDh/Hf0IiH4s/yDngN+KIX4w//u2//wHy/TrVzRQ1zuC7jc440fff/3APySA5SnKP+5EALOOXpZMhxvOQHyq+BXv5/MfyEA5z8VQjhnHIRz5TEEYJxz/8+eD97/by/ZzV6B46eKAJ1zG5x1pwGEC75Y5SxY2pwr+WH1AJ5iXeUz/17S760736m0CNRmIcTs6q7ovTve9wSYGfMbSojfci7nQFbDagtrDCwMT0AQrFYTcav/+Sp3yXf8smqO/vZa9nyvjPclAabO/B4cfkX6GxxIUWvhdAqdZXDGEEdkMWl1tqrj037OrY6iJBaK4FWcy/n98ZX6jt2/uuoDXOHjfUOAJF4tMGP9X/x/6b9gDc1/bKH7faT9Ppy1LC5ZY7NmLedb1e+JAOWqzzJ8xFG2UWzc+74Q0+95AjTGPAngiJD0iJ2oamTC2cF7ONgsQ9LvIU0S1scCqbzO5lZHgKslvvJa1rDf8pfgiLc/3dy+6+a1CvgrYbxnCbA3P2eDqCZUEEBIUVqmNic2wQ/df0p/Z/0EWmvoLIXVmr9XQrIF6w2JlY+1EOB6csBho7Z153vyWb7nLroze8ZEcV16wgu8hic8C7DO5laoJyjvn/O61/zZWTY8pMsJVHif3VrGWgiQ9E/ighd52Mb2Xepin2Q9x3uGANtTk4mDC1UYiLjRhFRBoeWVBOjoAdN76x+0zN+TztfvddkVIvK9vLfEE9L6ScblBy0CeQkkJctmh6yxY1ftvSCar3gCTGen3wCwSxMHkRJBFEJFNX6/mABLFzFZu/TAJWCyDL12B7De5cLC2hU3XnCkiykc80u8RAS4aLxZ27pz96U+6WrGxZ/5NY5sZua+5MyUddbuMrnLREoJqXLDYdjwbJAJTwoHl2mYNIOUItf1CgJgVzLke2EFXtjY1Tv5lu1NvnXf5b6Q5cYVOf/p1IyD8BxPWw1L3E8pRHEMFUeAVPmlLxbBhl0tRHBGaxa9RmeQQnhfHzujUbplZB5Iu7jmQX6Jl4cDLhi1rTvllSaWrygO2D8z8zv9MzPOVkRqofArpSCDoOpWHj6cF8HENbXO+LVQ8griG5DumkMU78nRP/W27Z96+3cu93VUxxXDAXtT04UJW+pnRCzaGia+qFaDiCJvWUAszwGtgbUaaZoiSxImxoBEMBkmuREicr7H/wl6d/ENxyuBAxaDDJX6tquvCOZz2S+iMzNztDc941hO5nTlhPfpmdxtIZSEIO4nxcBkXbR0PDlKj0sxhn19sF64Fv7Ahb+ml0unBbryvlawXcAlFfsvJnXpBpuAEv1TJ1x6+p2jF3pfFzouKwfsnTlzXAC7h12HY/FroCKFIIogo5jFr0OFA+ZPtdzZWbikjSxLkWUZrPFuGXY3LxHd9rKsP+GWEkfVPKpiDEtOvcLBvlAxwOLQMfwCFJAFVbLfVPLvrHPOOvtGc/uOvet6k6sYlw2Qmpw5c56ZdXDSTxabtUOHGDw9531+jojOFsZGFZrnFhHh5WH+w7ibG/Le5fd1IRyiJOryBIXm6/KFK4RQwZ5kft7FIyOXhRld8qfgnFPJmTPnDwkIASUVpFQQ0uto5cMZ/GRAZMay20VrbzUvOud638Z7arhBQNz/nXNhISVUoNi1lWUZqYaXPIpySQkwmZ4+kk5PZysT/YKND9o8pfldvGi2JQLZf2i81ZtlyCoEuKy/8KdwuALlnacU8PwpIsDAz7OUNG9EhUcu5XVdMgLsTU39Jpx7ajV6pyDikzInJFGauyVDc4PIh9Ep+/yMNiXHo/1yaP3Fuq0reix4uKzN+HwV6xxMbtzJQPE8CyEhpRTOuaeMMb95Wa7xYo3+5KknpBC/saqdiOiYABVQUcVZLS9kyED5A4yGMcT9zBIO+NNKgEtGvhhtoVwWcywWphQIIb6cw9wu+rjoRkgyPcWx3OWMuYJIqkQjiesFEkLlrpdS/PrB3/u9YEjvS/osfkUerlvM9WRuxCxHiO83US2W4SyGJAUZY1IijCOoKOT5LRKsFhxDiBuNMW8opS5qLPmicsDemanjTHznkLqLH35BgFIFbHyQaFjgeuEVKsvkH2d8vNcaw+aeUnIJ53u/Edi5hlxmoReJVOzioTkKA4hQDXyGlSkqVBcp5S7n3PGLer0X68CdqVNvCIE9zL3OIQKrXKm4cb8puBLGKfP3xSxZNjwcWb5EeMgBCBfrZt4jo5idxfPgSvXZQeZ6Hy1yjgKJ82rle6y1r1+sa74oz6x95vSTQshdBTGdbxQ+uoL7sV6iBh6BYXEM2kdnKYMOiMAXOmr+aQybCpsbdoq4H+t+Xg8U56FAIcRu5w3IdR/rToC9s7O/KSBuLDlZ4fhcZizhgKTDVRTj5eACC8AGJc5vSJjhp3QsZmwun2vigCoMWQwX7q1hobsh48jFsI7XlQCTdvuIsfrLecLMqnUv/r3MIx+LDI/Fg4wWnXnLl4ELFYL/p7HccF6vXoCpXPmMSSm/vN5+wnWzgp1zKuvMPyWs50JLKXuhEB0W1XAeScrht7LURWlIFD+2/o2xHOul8xX+LawxkL+mLDdG60iOsw7u1uZBXFt6iTjx09H15c5fDK+csDAa7OPU0lk2Kjhuy1v+W2EBKyGL3Bd4VA8KyJmteA4qh7W8wHOul08WGyWrW7ZPOecCIcTqc1mHjPVzwySpFtoiQG4NWAdLhgJ/KRaIhCJQ5p2ifpJoZQZhBEQh/51pjSiWPr/DeSIrvNCduTmSwQgZaaDYD2jzOiwXnwW6PI2TrosIMBrcnyDObfLsPFf+HC7w3EdUMS8DAnSlT3PwGQMRrIOk0yjASEBLlD48YTVUvtAVn9d5ItQOygkoGbDLRdMzIN1aBRgZHSmRRg5VDuhWO3HZeknPdSFAp61zaVKiL7CM4bBgVDkWic5S7/PcoiA4gQqqwHmolXBVrfLSK33lYhICRhRcVzJnknKgUInqjZJVL4VHw4iF/I9WYcG5y+/dwKHnf+88nIrWnPVMMCjQLjRvzBQFGM2LRUqdFHkOTeV6FtaMWO26Fc5Xbrrg5X7BBOise52BAM6d09g41yidz/kkldbw4nM5x/6+sjRGDrFHVYxeAp+fYMEqWQhbCWRMBR76RdxIOglpiwsTOeg1f498LVXvq0Iw1awVR1yvgu9jLJ8DlAWUU1CVYkdEfNL61FTar+DCnvuRdAkH6A2xMENmrWLDWntcSnlBUK4LIkDn3FE47C44k3Pnrf405CA+RsmQ+wrxKCVzsVWwSsviWGu9RGcr/r4kvNARF5NMDEYJGClgA6+jEdko4klaDbTcMmleMLJn2JBDFg3tk0mHNPeWSOZ4AoEtvcosYrneEv02lxJ0hlDkgAO2BRWUCtj1MnC5yFzoLhczWdkQQuwhGhBCPL7WY1wYAVr3GK8ka9kqXRMBFhxvUUwS1UhG5e8CbuXn2w22wdHWfkMrHhJOyPzxWeZIgXAsEkNLnGiAuyMiMsQdOWSdLZKvyEltUa4Q6XNOIBMO2jooK/gc0gg2MFjVCSIW6do5pHDQbBY5REJA5Xg/S6Qpc8LnCmADsSvyJXJ+P/R5x2MXcog1E6A2pgK6cwOAwBouhQmw8EkVLpyFP/A0lhN6vrTXeukXPKzIIzTCIbIGkqseeAKRrlDaJKxy0LnCRgw9FHKASq6Y/wO0T/GZv8WI7CvhII2vnqmcF/78A5I4xH1JX84r4hSGWFERh65T5qgXBva6gVbqVuCAXum4EH1wTQRonPsdnjrn3SEFBGr5K3CwtiJOK9fKqZZ5fb5StLoC9zfYR6cpFxWy1i70Ly5yI1xsMex8aVNkxqAlBCKhkEydwfSrx1ETERTqkHEDszrF+MG9CFsKiU0RzMzh9COPY+rtd2CsQxxHrM+mWiMOoyVGCN1JFgp0sxStWh2ipyE0Gf0RTBiibVLoWoTrH7gXo5s2oBYqaOLMxDmNZpEfRSGieh0ijAfo8ZznDc6zTvPi3O8IIX59tfutlQP+D/5FLKyVt4YbIl1vqcHhBrlHeSyZC0qaha4ndjxXmOGlsoedUgjDEEHWh+338dif/zlOv/gaGrKGXqqg601s3r8PW/bshAwNmiMhHv2Lv8RLf/QXkKnhXBcpfDzW5v7ExX5A4rCJ0qxn1lWIdLaNetSEERLtQOJsrDB+3T7c/pH7EOX7ku5H4phENydo5amspQW8BufzKgbRxP+42sewagK0rmICVHQvV1iky9zbMNRL/q74oHRt+HyI0rxlGNFaikJerEHah8r9dHp2BnPPPo/NRiAKAtTjGqacxXW33oJ4YgJIzuKtRx7FQ3/5NWxLO9jQGkWapazLkuFF96SEdz0Vw3vpLCJrUZchwtQicRKxAzrSIRxpYs70cOzBe1HfNg6nNTKdstmsZUAKoq8gESgvesupX7jQ15sMnXN2taJ4VSaQc25JiYcqYazEDbMEoCAqK1OIykcDSBVxPkMc8AohQCUlIoaKBTj50PfQ6vWxkQgo7eJsZxbbD16DLfv3AN0OTC/B3/7ff4Bau4dGGHGBTNIZI9LPrGVXitMZkOl8yyAyw6+xEDC9HmyaoBFFSHWKzFnMmz427t6JI/fegSTrIwmALiwSUlVyxIuKQqggHEQ9ho3lAu0XMIbRyLnGam3w7y44GRZywOWHWEp4BZEN0Qura5OOa3ICdPailzc7/yBjw5Jh4CB6PTz3o0cwpgQCm8CKFHOyjxsfvBNoKCCU+NEf/zHmnn8FW1QNIPGrHSIVQ0Gxky8KYkinlm70CxH41NLcaHAqQKYUTs7N4RP/6vMQoyPQcYREhUhonyBihzcRYBDGDDpA6Ri/ZGC1767mxyu+KufcG+X7itW7WtG4EPNXflj9wYLfMgesuHlwiRwtyw06N5OHkOi+dhy23UUIAyc0skBjz82H0bjmKqCmMHfyHXzra3+JbSpG0E2hECCK6mTPQmtaWECWGkgSmYs3EUBagRgxai5CYANEpO1lDrfefgd2HL0dppNBpw62Z1F3IRqqhSioAyLgbDexbDrrxR2rwQ+uRgfchUI8Vgkuz8FdmsMqFgTaRSUEVMRsB+CDKlXlsU7O87AQvHnfn8utROm8F0ta40vfSlc2S/BRBTk8yF81/fi9D5+J/D5kjio0AtBicA/SuRwU4DjyEcEg0AmeefwxjDZqEEkHqEXoBA53fvQeWJnBtjX+6j/8AXaIECppIxCSy4z00wSZzjjllIgkydJlq/Snmu7PILAk8gW6RmM2FPjFL3yRMwPVyCjCbop6VOP76XbmgFrMSfxVv6ovMLE4L/riDSHEimH8KyJA51y64AQFQTnD+oszmid48e0tENFm8IkLJaQKoWIPjHRCLFFG2LWVGdheF2naZ7oh3YuMEq8/OSZg0g+VdAiEhdVEvNGilZDrlUJW4soYOGXpWEpC9zIEUcx6WMbWpGVCVM7HXJVj2QtDNGoz2PlZTL79OkbYmq1jRjuMHNyL0RsOYb6dYfLRp9B78nmMd3twoUVqMoiAeKWBDD3aR0NDhAJO2sp1ivLyUuFgtEMTIXqpQ1pv4PBH70FweD/OQkOmGk2hIJIURlmkLSBuRKhFzbzsSH6Ll6H8ANGMEPQwzj1WemkLGrssYlZlt6AFAfbilzltFch89tEKcX45ytEDH36TrnDEwiNElEM2P4fTp05hJJQIuQC49rssc0vWDlcT2CEbBqyPBVED7W4bte1bEG/eiK5O8pjBIIZqc829PTUJ0+n6niNhhA76uPb6Ix4m1u7ihUd+AjvfRgCHTpogrtewXDcIV5SMy1UOUTjecxRLRvdVi5DUY+y7/x5uE6aVRGTEoBA7x+quqLyEcCU/Oi8BOre0hHzVQVzVBZdn8RUqrOh9wzzxA+IWPsWSPWI58RkvmrOkx9bk//6//i8YhUCcpqilGiHnOQy/Aq3NUJMvg0BCxKmBuNmCaTbwwL/8LG79xEeghMvxfsV9e45Jn8ycnoLsZ3xdbViIsRGM7NsLtBN0JmfwymNPYkQq9K3m9AKtiVCCoRpsOQ+u8Hv6qYqdj9/qIEASh9h+4yFcdegAE7QiUeubL3k7Qyq+fyWuHAok2hFCnLPawko44PA7WmB8uJy7LR/ccYsMjfPli1gBJFazD5DUtbCsfGWhWk3UJjbhQ/fdh0e/8V8Qnu1ge9hAoAwSp4e6gxhFs+Rz4X1mYQ2GHnSiMWM7vHQL2JMVlh8u2HQQLIqlztCbmUHdAmEQYFb3MH7NQbQ2bQKiBmYefw56cobxf6n0fj7iwGqZ2x1mxBHhM7kqhbZwOIMUt37sPqAR8r2ErAs7BplqNs0lIqXyyv9XzDjvajgnAboVmLfOuYWVCpYjqiI5Ti78bOjvc8xSajTHf6M86YjrBTqHztkZjKQxbv7QfXjr4YexQcRoTs9hpF7DjO6x7rYQWFeki9ilRohJYXsp4iBGFsfI6gpjrTpraK5AgwqUnFA5CdVL4aZnEZHYVjHShsXIwWsRkgjsaTzxzW+jrjX77WQUAP0EoSohM0Nvt3TCu0HETBgPd5i1KTYeuwnX3HYTXD1EkDiETnJExRIRKl9HJ5QxW89XhrfUD2utlcOwdflYE78uHc9uMbB+mSFQpgC6ghsulwgzCIDAWFNi/qTLxbJwqI+NoGNSbL56Ow5/8E5kVkMYg6zXhzYa2mT5qy9WxAgaV1REsdzOpnhPNNMMJVu2Nu1CCotaLeBj0PO3sgCLCu9+sQKu04NqdyFSX+YmGBtDfcsE11rRz7+EyedfQsy1qT1W0AkFnZmyHPCSzeWF2PJyc/yZ9Q4fgwAzRuOBf/FZmA11zCZdyJC9iCwT2GKXXgRL5J0DriAKPF9kZFkCPFcaHivJnBTkH7RU50+KpH2ICBhMIAXnprJ+U+D7qrAqY9Cba7POp4QXfWyQkGUaSMymfcjROkSkcOyBe5HWQ7iRBmaJm6kQqXFQUQMiiuFUlG8hoGKyNOCk36wM2N2S2AQucJ7YIoEgDqBiCSOJ43pipUVgM8OIlDTVbICEzidRRRvGsGHbFqDRwCN//TfYIANGyahAIGFggGJua/OoBHuJGKXMCFbEtRjcBUBJ3jJnEMQRMiGQBCFu/8hHsP2m65FIh74zCIMQThsPAlESYbOBsNHIy5hcGlDuaoY7R02gc3HA82Y/FQaIKApALiOxXQXVy7B05dHPQ/VAx3AbQBuf8+Dr2PFKN4xAFkyEqZJo6wTN/Xtx6y/8M7wwPwM90kLUaKE1sgnOKRgtoFSMOG5CyghChGyc0avfAlipoEOFLBDQkYQLJBMiJwHJouBjXm/QeoNIZynSzhxDyJgH1puoN8eAzOGpRx9FBKAWBQhChbhRhwrjssKrC9ifBKcEn4ve902GsB4z4RkJtEZH0DMpumRtRwr3fuqfMQKnnWaoN+poz7Vz6wPlMRjzl1d8vbLIj8eR5fjTUAJ0zm1Y7yuopmqKRdGO/F1OpT72C2e8wk98Tzg2ErKARJpEVG+gm2oEjRY9c1x//31oHT6AZKSFzAj2OSoRYrQ1hiiocUgrkCF/Vrz6LWJ4k41jJCQ+lYQNFDJrwMVVubKoXwSVO0GWpuj3u0yg3SxDtHEcqDXQeecETrz9DoJYMTRFQ7O4DFQEFcRwgYILgvLVKsXvmUfWYq6BLeMYhmR3GDHxXXvPnQgO7kdq/XXUVOSJj/17CjIMOERXVJDAFdp8wjm3cdjny3HAmXW/ABQ4TVl66Re4bkrxa7naAXEblWeScVYYw98lO58l6UZ9ByVrcKmD2LIFP/OlL2ESlsWRCgJfgkIF/D4IfWCea+Hx3z5UxRUCaItibw0HEWt6ad8w9i4gQmYEsihL6xJHNDb1GMdAcnRi8+atbM+98MxLaDQbEHWJvkg9RyMVw4Iz/kQYcj0WBL4ui8jPH9RrzNmjRh1BLUZiMqhGDcGWTTj0cx+DTvvsSI9lwAZTs17zQRy6nzDk+fTRpSuP8CrjzLAPL5nTyOYckGFCcuFEMcrZFrB1y92NuOEM/GLWCsz9tPKKedbJsKk+iqydQQR1WCux+757sO/WY5hPewjqERBJzCcdfjUky0PpAXOh5EgMvTIxcBHMEIGqoaZqUFoi7aQInERowDkYMjeobSU1UnIuiEAigG1btpEiieefeQbNsRH0XQYbAlEjhpJ07NATYJDj83Lik0yMiitVsX6ovJFFhJg5i6tvPoINe3YyMdIFSFoYqeFKsESAMlK+ygEkO6fdcl6FK2OsTAd0zv379T5zkaHlS2+Isuazc0vRNAy9yp3GxP2Y47ClJ/g9TXZoFRpBAy1Rh8gEOvM9iMYI7v3Mp5HVJGZ0B2hG0DWBJLToCI00BrKa8Fs8eCURqBCiHtRQJ10tA7JuBmUVJwEpW1ScsjDSbxAW2mkWnSRKG2ObGOly8o23EMQx54GoZsycN1QKtXrNE14QEivkV8FGkX8VQcQqhhMSmtZKXENQq+HwfXejVw8gW00GsIYaiIWCM97/xwStCrxfXrxpHZI8LtYYRlvDOOCvnPsoKDnVID+3SAGslH8te3FUoPp5aTW3uMqpK/aw3DzaAw+Iw4RsqUKGudESMPHWGg3MkyLebPADjUfH2EE9snMnDt13P/qKxG0NrbgBaSzD39kLrGSepCPZYrQqgA4UczL6nkS7tA79bt9blEKWLiOUYHbnCYVEs9UIiUJrAdJ+B6bb43MpMnpUK08hzWBrkuH1Tnl0Mln1LATyQLNQjs8bk34qY5xNDOK9e7Hr6DGMbRjHXLsLGdUQ1JsQUR1hcxRCeaNK5v9yFP8C1NACrOaVgaVcQltrCFN7gjE65YYw3vJ3eemJhdE2FIuROImQ3F6VrbVKV2mGp5NVTIfVGpb0H+V9ZyZqIEkSXv2+AaEHEPTJSKnHaOsUCATHf5MkQxzVsO22D+DFx59DZAME1rKS3odGqrwLRFlfTsPSPoIsXgurNJKe5tUYBBGmTp9kRzUZCYbui4nNsVHEmAQZIQgbiOw0QmKPoyGm33kLTZrNvoWQdRgrERJxRQnmRcqcUhnFDuSAjiMNH5vFepZhtNGAQswL4u2zM/jSZ34RiQzRbyeArKFnfIol8qVN+qtJDXPe6qD5r9Vqvrb2e2AsIEDn3PnL6OaRhQqCfGGNuUXAlgKssIQysTQ/wVVSOxkMk2boJanPnahUUF3Ot6mzBON7dmPL9Ycx+9Tz2BTFkNDsbNbC+kAEAwoUrPOplSRfRSihTABrBIzV0N0OdJLANSJeWKyfiQGMjKs4hL6ESBgGQByg0z7LIbyAdEoXMOA0IHkuM2/VWn8+ax0MtJcEeVNFiYgXHMIaJufmsPeWmzF+3QG0kz4SbReGMYt7beuhc9Bo1JkAr9RhjPmflFL/rvh7sQj+rYt36gH4oEDDLCamIr+YL4yroKL8/TD3zeKNnbKtOu752Y/hte4sOq0IbSKwIEIgfTV4GxFnVd7nF+Y6FHFGei996K7XmUc36UEVakaui9o80B9y08SY04lUROI9wNkzM+w0Z4d5Lvpc/t4n33ujx8QKOpb8GgQBQhUiimIkQmBGWZwJLD79q19EQvvm1QyG3eu5tit5SCl/e8Hfl+rEBfq+gOEXeR9klBSRFWuLCvfez1UgoatbgZAuYPrVTRPxkIG7aweOfeJDeObUCbhWA5lzHIsla5SsTyJAxxakhFT+3Iph7CG7aNJulwsgKY5B+2pcpujKLiSiWh2yUUfqZ5S/6HTaHjYmJALSJ5XkY4YcoxX8GZ3PRQK2RiZywOI+FhGkiKCjEG9153HzRx6A3L4Z8zCc4Wbs0vuk7b1IfMNGKYIvhvN54RBYXBBnwahA75UrOJxP2azqM+dqu0BiLCWdzmW4/Wc/hpeffw6zM21sDWJOXZTSIVN5OTcIhCY3ioTnREYBkVWYbc+jc+oktm3fyuBU1m/JGpc+LBg3WpD1Jn+nWFfQMEkGaM0REGlDhl6FImQ8oBIRrFAMGsgYgOurXoUOiJ1En/S7eh3xaAs33H8PJtM+MrKaaS6WQZNeIUbFmgbRmhBiFos44OTFOuFKPAMDseWWfGYraZlVTrh4M87CBApdKRFtHsc9n/wEpro9BGRBiggRFEKhoIgjSY+YrEmJZq3G1msYBwhDhaQ9j97J0xwODKxfM94d5NEpLH7rngMSdyVDgMN0RucAUd+3uARSWMdx40gIBLRJyVUSQhEgQIRarYW+E7j25psQbd2MNAjyuLGPnw+71/f4OF28qS6viwrcLtrtIxe3zIUqxSe5SkCa13wWErV6nf1wBccroiZcXHuZh+Cc5LYNqhbh9PwcrjpwAIeOHkX6ytvYGMfIdIIYGbIsQbvTgUktsn6PjYLMWkzPzcOEMeaMxvFnn8Gh++5hUADZmQwNEwF63QQN4oDjG8ncRJJmDJ6QQuDUyXcxnWYQDOEKEbouIqdhEDMxaasxsmUTh+9Ggho6fYGRqAnTHEHainDs7ruhohrrlCS6TaKXFavLfb7YBXOFNuop0dKXLlugov8NmxDP2RZmvQ1FTC8O4VUGA0ZVjDRLoII6mhtauPaGG/G9nzyDN985hUYApDJD3yas+0XWsQuEy7kEimtOc7gu03jx8SfxMeugeglEHHIBTdIIiTCcdRjZtAmTQchhsqTXQ0RGjnWwacoi3V+P5rCdY2SzA0yG/uwsssxg3nbQtxH6scHk1DRu/9yn0Nwwjjnty7yZzEAJNaimsdZpP8d8XQnjisFve+vXN5q5kHASST5hJIMOnFS4+vB1GNl1FXqhRDtLWVdrigCxdUh6HY+rs445b8iIYqAeKJx54y10jr/B3IjIgKxoMjaioAZrgPGt27yfEEBnbh71OEYsFRsu1f7ELLSdY9FbJ/0w1YgNoIzjsOTZLEUvCnDdbbchiGuw2tcfdQYMLn2/DyZA59zvXc6LGNT9q1TKWsPg1A7tGKVMD7KXWQSbNuEDP/cJzAiDNA5YfNp+CplpjmooCTTCkAGtcaAgjUFdKc7n+Mev/xVEvQEZhHkBdA9KJXE6tmUzVL3BnLE938ZIo8F6pYDNfzGIApF1TJzWWA2XpBCpZj9hogSmTIrbPvlRbNy1k4sLBSL0PkQVXYmic91GQXMFAf7SZbyU0rDgAovKF+1ZE6pX+A5AUga+4E8Yoq+AHTdfj2vvvAVtGCRpgloUo8ZVAwAZCNhMc0HwKJA+DznJMBLG+OHffQs4eZIBC2xkkCWrPbJZNZoY37Gdzzl9ZhobxjZALsgLdIOyus6HKK2wfsK5ur/FbJIg2r4Z93z659GPI4ZchTLi+oJhGC2byfc+Gb+MMnkUWL+4zZA5O+c05vFLU1RYFedw1ZxncKSDlHdjuDRFah06zqIjDD79K19EffMmnO11EIUhRzC0M5wtZ7VGHES8H0+INpz03p+bxw/++m8YIkaLIgpCJlbiZmQBHzh0iAlr8t2T2Dg6WibO+/qQC+86oIURBWxtx1HM0RQTB7j3n38C4dZxpJFicCwjpy24MKWTq+mX/p4bqgCHr2lUMZplZYQhHb5t8VsllzREKY2NvNZxwUGKSu7VbP6VBNUFd0xPGdBAYjzVGUjYdYxDtO0qHLrrbrhNG/H2/FkkmcNEY8zrYoHHByKziJyv+Ud64VijiUd/8EOks2e5UJB0GTKlkUkD4zRG9l2DnpToz54FGk30ajXAKsYQ0si4akTAsd+ADJRMI3UGNoowL4ARuqY778NsV8MENegwQiosW+VWJ8yVr0zTYf3G2ghQVACmhaKd6zrSDTC5JeBFCoYplb0syix1b+la4jzSRyIWRj3y/XOXwjmSq3iQnRpajvRC6xRhUIMUxO1a6GQWH/jZn0Ow+2pGTickUrsGgZHIJBGrZaCCMoxvyPU9YOatt/HsD37IHFFnHagRBVuzcMLA7diKjbt2A3NtrmJQ23U1rFFQxt99QuJcRUzMymjG8WV5fb9eVMfdH/t5jDYmoIImUi2Zq2oFjpgEQudRmPf1WFsWs8PSyl5LoQWDDxyWto2vHs0WtQWr3G2NYrjQu0rkQF5IpG8s6hObcM8nPwnRanK+RT81lSnw1b996pPfqxFFcL0eHvv7b6EzNYW6kjCm0hg71bj9vgcwOz2DqelZXHvgkI8PSw8Qjeo1JHTMwKsVZE+TijCXpth8zV4cvOUo15SxedJSKUFEbsS8nwWwH0465/71ZfURWbewyPk6xTWLMuHIdUPSwfo6w3U33oCr9u/jsmamWeOgf9nqQZIEtTQrPnUzSzFWi/H6k0/jlcce5xosOumxu4b0QaEdRvbuRtxoYmbmLK47dAhz823fkQhcTwQJMujIX0MtroO0zCwMsfPoEdR3boEOZd4XyaOvCwBskRT1fpbBRHt0i1+4nLe5uPQazgO5Ot9YHPYr+IhRAi4MIEYauPn+e9EJFc4KC01Wt/PuE0N/S8vQLQiLUFiIThdxv48ff+Mb6Kd9tKKAK+JzXgupDTLAnkOHMPPqcezYtRdGKfStgVCCCxJpZdGXmc9+62mkViDaNIbbP3Qfg1TbwjDKWjjLemKZArAOc/seGF8gArz7cl6Bc3Zp/b8LJMBFZ2DxnxrDCUsiirDnyPXYcegQprRGFkUDXTWH/1vpxXEsBdDvoQHgtSefxCs/ethj/opq9EpwXsf2QwdxanoGsyrE/uuvR8IFlQSEcQgChYTEtvQ4xLNJhg/+zMcxtudqzEmLXo5T9ABp54EYufqwtqYX76lxNxFg/XJeQRVssGCsce6HcQ7O6w0UR0L6UkK0WvjQpz+Ffr2BOWc5F9dXZc7zgPncFlan2Dw6yhPUcBb/6f/6P2GmTud5GMI3khEaE7t3IiK98tQkbrn3Hs4VZqS+UKgHIXf1ZIR3WMeGq67GB37uZ9GxBvMmQx+Gz8lQLoeyRXeZR722aXivjPqajBBiToqzyRTPkCnRykt/5wEEy1NT0k/Kgt1FocaCIy7WB1eCBHGVTpzejeEfYz9JOAMtkwqIamhu24FPfP5fYFYbmCBkI6Xw+4ZBgDBQqKmQcYEBHAJj0Hn3XfzJV77C8WJtNDppD6IZA80a9hw+hBOvvYrDH34Q090eJ6kz3KtvsKk5ip52mOr38ZkvfQlhrcaIl7DV8jnCAnn3zQHSfK2EV52jYmFzfe0h2MpLsZ3vea1bLHhJsxX/6Xn3c9X9L9gYKsTWYi2QaC7iINnZXhcdB4xdtRP7b7kVVx08hK4ARicmMDl1BqP1FpR2jEQJ45ANCeM0QiGwqVbHSz94GD/56n9m3F+zWeNSaWjG2HPDYZyamQG2bcGxu+6ClCFCBEjn+4AB65rX3nY7Jg4c4CT2fpohTVIW0yIvxsTIa2nz4koXOBXvkXHFgBHWZRSJTkNcRJwaKoCw1oCRCp1UY+vua3DrAw+iIwROTM9gy+bt0N0Utm+4JVaSaVjlS18I57ChVkf/5Bn86M++jlPPvgiVGnba2ACINo7iqgP78eqzT+HQHbdzrpDRQKPWRJpZ6Hodh+79IMKJcSSQUCriLDjOa3P+2rQouyH/1Iz3FQGWNWhK7mFLnhiHMSxxm8BXQGgnGVwYMwpl057dQBwzACDIJMhoDUDGg0EWSLg45GPHVuDqxijmX3odj37160jOzGCsUUen22ECP3TjEfz4lRew/cbrETRHENRa6GQGLoqwYfcu7Ln9FqRxhG6muciRTC1sX/skrLzKVZbXo+FqDD8FjPD9R4CVrfoAOZ1SKdZL+plm6FNqHZqbNuGmB+6Hi2IkfQ1lJFphAyEUwnodJlTo0yyFEjbJ0DISWxHiib/4K5z44SMQcx2MNRpcR7qxYQMO3XYrpjttXLV/P2b6PUbMTHf7OPahByC3TqCnBBdZMokBEoNWEHsOXVjg5QL6aSC/S0aA6zWRbtH7pTGZIkV0wAW9fdvrdBlUQKKP6ww6H35zQYCjd9yBDeObUa+3GIgQ59g/boeal0sTSsIRN+uliPspNjuJ3/utf4epl16G7fd86qWSuO6Wo+goiT033gQdhghGRjC+excOf+A2tIXFbJZChRFXOCDiG43rLILpn5GOLXIr1nfWruSxBgIsqq97N73L47lucfjL5fVguArAAGxTtYrsouYz1UiI45b/Og+RmdySdpwMv1TLK8CfLk+LHITVighfKCV0kjFiOeCaMBKZtOjHIey2Hbj3Fz+P02fbiGujjFjWzqFHBga3YSUrOIdShQIipt1T7B1t4vd+48uYe/ZVxD3fSDHRFoeOHsPmQwfQ2L8Pz86exX2f/a8gN2ziCIpg694ijAL2vXT7bS5BIoQrXTAXwvuUkgvm8kpGQ2PtHDDvQetE2RS5eI+8nzjRAOlcXFlUqTINszoM9/71QIQiNRNFMUtbpB964zgMfZ6wN+1NGbsdqO3GuzLyleDymK7Nr4lL2DLiOT82NFwoMC+BmSDAgTvuwlUHbsBcP2OLlTuQBwLSatSc79sWBL42YU9lkHWLoD+P+N1JfOd3v4JTr70BEQhEkAibLYS7rkJ937XYeOQmXHffh7g4ZmAcGkEIqzOOuhipuYSbEyYHsg42rHELgmAJ4V3JKZtiJXWgFw9HXMg6pL0+bOqbrghTJJR7itHGcECeS6HFEWStViYkydwuzZI+up15JiruMyJ830g+hpSwYcjHIU4q80nVWi/rsvFlQFaxpgS4s6R1FuN9IHn5dfzhf/NrCNI2nEhhIiISw2iWwMq8F7CEkCTKLXrtHuLmRpzKNHbf+0F88r//bzE6Mc66pbQSk2+fwJnTkzhy801IJZBIlL3bnBsQhi2kyToI3Vqthijy7TkWJ/JfDoT1+Yh/TUkHiysblGJzLTdYuUCx4IIFAm43P3As0/FDqUqOOey6lFpRe4pyaPh8EBUILnJ588cfwHf/81exseZjxMpWwoNFuwgIzo6r15to9ztcCPPph74HGUl89su/gTiKOMFp2/5rsGPftSxoAuJsamAIadZHFVdZ8AlPWBeV3F4J/fRWMdY16+VC1u8SYoZD0u2W/c4GtWFkjjYZcm62JM3gA1c1gxeBFPP3pFuGeUwato99P/9xPPP8k+i8cRxN5ztaLgbfOu1QjxqckBTHMUO0do228Mw3/w4bGg188N98CSPbt6ObdCFUzLjEpN/n0r9evfBRF+JUHP0pOeBPkwfQjzUCUhfqFhcGHhi+r0/mET6BW/qEcuKIcRAgz/hgbqQ86skjWpwvcM7t7PNXsmp5q35G7/PPkGq2bJOkD7QibNq3Ezf97Edh6nWfhO4C7l4pWHHwIFW6jkCGyLTlzunKGmB2FrvrDTz+zb/FN7/y7zF14k0ujtl1Bv0s4+w6uiuu2G/tIPRY1iwZXu/m/VQXZti4YvyAS/U6kWeV+UdfVEz1tVd8fi698iYHr8Vh5IJ6NEs/k/nfisuuCaTOoh8IpDWJg3fdjvrEODImt6Ihgiy7O9F5dGaYg9XrEUyaYjQM0DAGG5TEc48+Cpv0uDScCSU0XXMcl7FuulfaN4wiX16XuKx16xJ7fa8Nega9lf64CHRnaeqxcGFYVirgUQENMMQ+n/Asy/ISE3ZQ2YDbZ2lO0uHCQlqzoVGsZPqMHhK973a7Xl+q1/lYRbm2wuKjjXQpo/OE2iGbD/ZbbibDJdGEY72PfYNhhLjZxNm0D1ePUdu6Gbf+zM+gQ7oaFFv5XEU4s2g1m75eDTdKtKjFMU/ixpFR6H7Csd1bjx3Dlu3bSzR4ag0yrdHpdLjVP424VvNl3nLQxXpxwOW44WKAAtddlLJ8HvyMrC3nlp7HJRg9mrsfnu9Xi1Eo9OCzJGFCJAuVS2oYsyYdsNfv82sxGYWOxDi6NOVjk57FFnC/z9/T5Im8xwidv58kODszc04wQ2FBmzz/pICBiUhx2wWjfSZdT2uuVPWBn/8kRq7eia4EUgguoUZiPuH7Tnj/WhyhM0dGyChOT89C1huY66e47cMfBZojDDYg6z5UkkU8nddn7IV8HJ2mvmXtJRrFc6TFTNYyzUe73eZXWhj0eVF9azlDb53HP9Dd/+G54t/DigXRgybxEUQRQ5OiyK/qtYgAEj0lMeUrkCaAzlGr11lE6bxujApUuUKts2W9afqcOUtRVWHYhoEFan0DXZ8KKgWjpTXpcdpyudtABnCjLXz8l7+ITiS54FGaaS7xlqWZL7QuDDu1SXwbJ2HiGqa0xbEHP4TNN95MbI8TnIg/+p48jp3ENH/1RsOLX3lp+7rRHBPzKOBZyI2oxf2K6W+6Nprzizz+QAoh/uNK3CcLfuMGrUWznPtxtfZlGi+fa7AVGobemrSWxRSJAxrdboeJLIw9ajnlOi5e3BJRkoWsdeaBAo06+r3ewjQ9MWid0e13IQPJUHnuPRwFTIi9LOGkoVAGkKnhavfcF84Z7Ln/blx79Eb0neMq9/V6PSdg7duIaYM4CNFPNPphjP7ICO764heAIIbtZdztMqZ9OenddzCn+7QFPu8S++WqUqAo9ISKWC4wmFVpdDEH0d65WnUtycWtckA2CoKAJ7TX66HX6Xgrc5VDSoV+v883H4UhGo0GRjZsYDHVbLVKsGtrbNQ7pa0PsNHD07moYHAsceJauDCOVZm/erPBhMwOcmuYsKN6jOamMSBUTKejYQ0tWeMdDVfvyvDBL33BN7CBDzZEtZovA+dSjDRrjGZRQYyT7S5uuO9+NA8dZk6KsAapHQLtO74768OOpMcq0m3pcFpzYaNLNYizFeBfIi7icPRZwfEKoiMGQCpCoa9exHH+6jfDEsJffukltgSdNmjVG5iYmOCcVy5bIRaDQcWSt9XB8dM0xUirxfWgp0+fZhHXabcxumkC4xPj6HV7nHshSC/Umddhmg288847pU5IE3voyGEk3c5QhYL2SXXGmWZk+Lxz6iTePfEuNk5MwAiJnVu2I0wNw/BN6JvQkFieuHon7vzIh/HcN77JvYW5BrSVTHSw3kq3MsTI1h24+eMf5+TzLAwZziVdBpuksMKwdDhz5gymp6f5AYdxDbv37r2kIpirO+Sin4iPXumaZmZmmIkQwe3evZv1Q7MGZrKG4VYsM6vs+I/+0x8xlD5LUly1fTs++7nPYcv4BAMBWLcQXt+ivw3pHfV6GUlgVs9QeR/hII5EnM84hyeffAIPfec7LNaJ3n/hF34BE+MbuehPv9vJAQq+SUyn28Ef/8kfY25ujjnyxJbNOHj4AIs3D0pApdm0g9GSrXBFOp+1ePQnP8EP/+FhIFLcHuu//uK/wa7N2xELiQwaaZZCBjU0QoEDn/w4XnziSSRTM+jPzXHxotABGel5jSbaVjOucGLvXm4wk4YKxjr2F2a9Hj/o06dP4k+/9leYPDPJocsjN92Iq3buYk6fz/B6P9xlR6EL0sJ96KGH8OMf/5hVn40bN+Luu+/GAw88cN4iAOs0yqzsJeRemPIFa65uD37owwijGPVmE1MzM3j0scfyNlyC3WYiR67AGo4kMIsXAyIudB/aJ4xCDkt1ez289MrLHD+2QuDAwQPYf81eGHqAJDKtB5cq4fuJNJt1xrvE9RongHOtFWtZvJJoo81pX43ApYZdJFZbOG0ZeKq1Q6s1grjRQFALuXuSJlFpHDerUTaAESGXy5i4djeuuf8enCYLtj7CzmnbM9zea14bYGQEh+66A42REa4lSCI7qwXoKYfUOe5uKcOYVZZGa5SxiCR86G8f6bs0CcCFUVE8h8nJSbz00kssHXbu3MkE+cILL+Ddd98tRfFFHKaM3Ash/sNq9jx48DpcffXVbMmRDvjMs8/ixMmTXJmqkH42N+eDOGL0h8Oitv4Vv9fo6Ahee/VVvP3W22Wh8LvuvLNMMVru0fCCUHLhai1LfgxQW1UkTgkbq9Sf5or8eSiMOFehbdD9Tc3Ocqusuz76YaBR47ouqRMQMkQ/M5zVNr53F6656QYgDLzjnFu7at90ka4x9A12uEmNCngbnkNzcYfKvQDIPQAPP/ww69+tVoslCT3L2dlZvPLKK94ve3G54O+jiIQIIX51NXuOj4/j2LFjPKFkGRLnefKJx5FlKV941WVCT7PX7S7Qy5hwhMxhWt6q/eEPf8j70EO74YYbsGPHjryJ0tL6yCI/BokyrmhalHQrenmg8nsM9nHVwpHCw8TI+mWAQxGjzd00ZOokWcLNsNNeH9GO7fjY5z6Lt89OQzWb3GWJXjvC4cYH70fQanJ/ERiLQDvIxHPfIAogahH3gSO1hPSswoF+qUfh4Ke5On78OJ577rnS2U96PBEgfUdckXTDi3wtTHNrInHiOtdcey1279rldbggwIkTJ/D22+8gbja4GTWJFycFizWv0C5Kqcw5YK1Rxz8+8giLYLZ8m03cdvvtfNyCWIrIyaCFg8i5l2TfXEGAnuu5knBR/u3K/sTV2smK0y8DH8JzIi90rmEKMKsAGq0GI2aks7j55z6BPTcdQRuOq93PmQyN7Vtx4/13cTWrXpb6GtXaQpF+aIEgirnfh8sXXMil4cKSu1xKQiyiR6Tvke5XEN/o6Cg+85nPsA5I10bER1zwUow1EaBxFq2REdxw5EgOKYrQ7rT5okm/i2s1Bn0Cvjg5PejFpTeK18lTk3jqySc5xBUFIY4cOYKx0VH+fjEhFS+iwsGKrRSxQIkqcc4t00M7J0ApfQ5w0QKrqMKfd0mXSiDJMg/Ltx4Ee9+//Dz6tYg7mU/2evjn//pfASMNpNyJM+AOSyrTCK1PbFJRxOU6DHdYkgs44OXC5z377LNs+RYx6aNHjzLx3XvvvXx99NkjjzyCs2fPXvTrqRLgioN/HLs1GgevO4iJzZuRacNE9/yLL2Dy9GnWd4zOfXSM+FgYaxnogQLPv/Ac2u0O+/9aIy3s27+fCSo7jxd+scN0AScZ8lyrOmBBxHx9QnJqZMkBBSda+l5x1vID0Q6cIWdbTWw+cj2uuv46nMkyTOzdg10ffpBdQykpfgG44CW414nvj6dof+747hb0PbkcIpgIn4jq5Zdf5vcjIyPYvHlz6XrZtm0bNm3aVPZl+f73v3+xLqWktSoBbl7p3qR7kRiu1et48MMf4ugCcbqR0RF856HvcgUClRsk7XYb9VaL8XBFCMjHex0TK03G+Pgm1h337N6DLZs3+3rRi6MvVaBCXlGVHiYTbqvl48VDIGLFRhYdbXRsncdyGZEiA4zUR7irJhNH6CsVsOpAijh8NyfiZNZkiOPQ+/s2jOHn/80vcfJvQnovHMOuYhJrxvEc1RpNTlA3kNybrtFoMkHTwy5i3hdD0Sdrtqg4Oz8/X+rl9DfNNz2Twsl87bXXsv5H10HzSNyQ5yUM8fbbb+Ott94qr7U4NhY/m9WPktbKuy8616xkePHnXYh08UduOMI6EyM+2m0899RTvjM6GSmNOnrtNn9frHyPxujj9ddf5xulmyJjZu/eveXErfQ6hBQreogFt2QdLIq5hy+dk4lhUWVXJ1xZ3V7laqcVEikk54vsOLAfn/jSFzC2fz8XKOozSy1Kk/vSuhwADlRZKoQjMEaXSCG5CGi7XqPg2kV8l4iK0UJhiFOnTrGBQQuR7ps44L59+/iaCtDH9u3bsXXr1tJh/cQTT7CFXFwz7XehqkOV1la9/BjzaU2pK9UbDbZa6WZIDIdRhMeffALtbod1HuJ0rOznK64IAXW7Xbz22mula4AIeduOHXyTWabP2260EMGcj7K47f+QIfPfewBDhTtC5LFfsaCQpiDis76Pr+SmR766VSoUgs3jOHj/B9GY2Mjile6vFtY4LsypnKECaiEXSWeXO/eQEwgCr18VSOhqF9D1GtUYb7HY2SuhFPv4SASToUdc8MYbbyy5X/Fb0gWJEcjcw3Hy5EneCnhWUc97vVSIxQT45ZXepGWL0bMH0gOv3bevFC10I8+/8CKH5YgTFtmaxUUTMR5/7TiHfyQDCjRuPnoU1uh8dcbnDgXlhFb68VbAAQuYkbO5nzA3Yji7b0giJHPAomCk9fVbiJi0kOhZA9eIuQdx5gQCbrnli5hzYfFIAVxXxh9XQbKojypxV+QRifV29hZQs2KuPeYyZsv21VdfZUZB323ZsgWHDh0q56GIE9PfpBOSaoMcLUOSqkArFee4gPE/L7je6h9CiN9eyRGEzK1P6UVMFEfYs2cvfx7VauxOef3145iZnWWOkqQJx3MLHZBu4Jlnn0Wz2eK/SQ/ZsnUrup1ecR3nXWElB1RqwQpebpiiWhN8s0K6xiiOmWMPUqIK8ZtXTXWWIznSyrJkgRECfSmQ1EJfZZU7IFlkvT53bed2ZHEIG0kutWGF5SY1sVIl56tuRQbbeg5R8WkSU6DzfO973ysxfyR9HnzwwdIaL5hAIaXIMLnmmmtKQMKJEyfYQV0ccwEIefXXtqAl8JpImRGzRWvV3K9GhgSxbg+P926XE++8wxwwyh2chSP04YcfZm4XhgHqtTruuecetNkTH7JbpN/rl5NRTUGvZsehAuNfyYos/G9MqMayUUT6ar/bLSvyV81nn6eb12hxpXs7L0ypONcjZZeUQChDrppgtWHABLf9EgKaH5ifZPqOHjxtxPkLzrfenc2r4JGCEInzEQcsQAb0nMbHxxecu/qe9iXxTNwSufX8zDPPlMTnmwqtjwtp2JP7yvl38+2oJIoIA7ixyqFD17OyTd9kqcYzzzyHbpJ5Jd5ZVsJnZ2fw7W9/C2nSw9TpU+zMJsvRZRn74zh6AJ9c5MoevZVTV3rOkR4zNTmJqdOTMGmGqifQy1lbvldK5g0SfV/ibreD06dP4fTUKcy3Z6BNj5PfTZaymNbG+nNLwSUzHIcuNaTNEDrLBcpt5nOiZRjyRgQXRTUWt1x8yHlDRuT+xcnJSeYmpFORYr8Y5rbarTDYSMer1lSsOtvpPLTgyRqm8xNXu+6665b8lgiwMJDoOzJebrrpJg7V0XdExO+++y4vnAuotrCEtpYQoBDi357rCHTagKsMBOzXYh1CSIRBhFajiYMHDnGI56133sVzz72Ip598mtulKraiBB79yY8xN3MGb73xBrct3bN7t3feck6l4ZZZqkiTrBgFZdWP3LlNW0GAZ6amuHmMLDE2xeZrPRc+Pd8Q2yOp6W8iwk5nDvPtaSYwsh2IUwVSoFarw6mArVynPJBVCZcXq7RoiQB1GfJ5+1kKEYWoj41ABVxwjQkw4HxgUZRnYM5HD5SIgXOcw3DNxSOHgUQW53vQ6/Hjx/Hmm2+WhD86OsoitoqCrmI/q0bM/v37mWu++OKLvO/Xvva10mhcCwccRltrq5B6jvolN99yC0ZHx1hnoIt8+EcPM5cgXYdW4Msvv+wrHziH62+4AZs2Lu2TLYadDCsrnLf0ms69E9e4oU0F3J0ojGJGufiqImrJxr/POX7BBdhloSTHtBfPTwnQZivYewPcot7Hi/XClWxFElFhnRbGBL0WIGH6zRNPPMELtfieDI8ixwbnMSjoPNdffz0vGiJmIsRXXnmFiXK9/JfLHWXjWg7GE2stPvWpT/kQVxji9OnT+O53v8uB+McfewxTU1M8EeMTExxPXu5GRFXxW9yBabFieAHqiPfRWS4xcna+m+uqHs9HjIvz6RwWvCeunOmMHwzdI71mRAh5iGVxR6iiFEcBBKUHWIi8IA9TrnYDBmWSC73M5LkzyLnt22+/zQue9E4aREz79u1bgIjGeZzKO3fuxOHDh/maiXt+4xvfKJ3RqxxDaWro01+NU3rBwZRi5AsRFymxdIP1eh0/+tGPWCy//MorLH7ogR05cgRbt2w5580P5bRu4UVfKKiJwbFkDYYhmiMtLl7piAhVAF9LQ3KzQuRtGegzRTqfUuxPU3mct9ZolOkDw26ECLbgXqi4hQqf2mq3whItRHiQo4LotdDhyPIlYims7TvvvNOHFnNAajU/ZLmxYcMGJtzCBUPGzNNPP73qeV6Ops6FiKazHFnNSWgC6MZPnTyJY7feyv6jXrfHQIX/8td/jbn5eSbIDSMjuOOuu1ZdE3pRSBliaYW21Y1cPZNhhLNzbYxv2cyxXF8F33FfYAdbIqudQInqdnnmXqfbRaPVQkoPmiztIFr2koqKCIX4LCIMa3HFFMYHcSXGXeactCCmRx55BG+88UYZFSHi8xC3wW8KYj2fOD148CBHR+h4tD9ZxKQfjuagkRWMp4c8Pn8Ny+0hhLhxtZWzSCGns2zZsgUb0wzXHbwOP/jBD5izzMzO8uQT9/vE5z7LOSBYAxxJVAhvmfyjVQ2lSJ+y+PO/+Bo/DNKXaBGZvHbhkvIybIBb7ifXaDYxMz2NWr3B3OSXfvmXce2+A+VvqxdWhByLSAKJxt/93d9lUbkWhZ6OQVbqpz/9aV7UhY5X5Hp89atfZQKhz+n7j33sYyWh0e/oWgrxfS4ipPui/e+44w7W/2ixvPDCCxwjJs64kkG0tNx36xoJD6JKlQMlmQtObJ7g0F3hZ6JVeP2NN3rlWUoO8pf+Oefb9pdoFTfYqsTGD7HnE9pJ1xR5qThRsdAWP1Sfkmg48sGdMeEtXbpe4kj04OiaioTtIvtPVHKLCxQzl+cIAsyeneXFRQ+Tk+WZcy6s0lqE9xiskfvVikVH5y3E5mo3MiQKF0k1f5f+/rM/+zNeRKT7dTod3H777bywqoMIqdAFz2eI0Lj55ps5bFeI729/+9vl4qH7EGuskHbOpCQhxKrqBxb+pOKBkrl/5IYj+Mljj0LFAbti7n/gAeaUhRIuBufynE0sg+GrVP8IA6/HjDZbmO90uUE16Sppp7vstfnYZs2LXW3QqMfct1dbw747hmMJ58VtjucXTnLPuDJKwsBUyS4bJQXCWsw+TDo/R1XCcInTvLjBIsxF3KSwQi/ECU37EkEXiwY5Vzxx4gSLdiIw0lG3bdvGIpTm50Ljzp/73OfwJ3/yJ6X6QCL5wIEDfD9FimehDhRDnqtJzEokl/PlSM/NKQvMKPfr9XkQ3fk2T8Lc2bOYOTsLEUrWk3bv2YM4z+Ng5d9aJJ0Okm7P+/DySfJNcKoFy+SAm0ByLZc3Xz8OkXciisIQW7dNIM16lf7DhQUtuSa0ikIuBRLX6zg9fYYnrQpK4DBdxZ0t3KAlLXICLH5nnXcC07GS3Al+1VVXodEcGdT6q8xut9PFuydOlFzCVHKa1yKCC91x+/bt5Wd0bOJ4p0+fZu5YEDsxAvrtas9TTVYvLPYXX3yxFNukFzYaDZ9sn/+O5rSST2zVeVbZilSn83LBQYyMQ1x0szpNuYwFP1wluSQtl93QGq1GveQIdAFZr5cTIGcz8aGWI0Bwx3uNKK6xmI+imAGxxFU73XnUGuFQAuynGfvp+pyvEnDITHG2nvDRCgwpIegWNuYuJsxxVVMwEjyq+U5nZE3TQgjDOHeaywXdfhWXJDYLukFdqC9tMeigIJKCEAqiKwo6rZbjFvsWxgoRNXFVN6SraSGaq6SilDovfa00LzgjdWsFV+zDahzztSWRZalGXPclKarxW7YKKxWuRJ7vUR1icOiyCGW9Vmci1Eaj30/YkPAok+UnuNVoctZeEAbIjGVXi69UahDJXGEjcetkpV9W8VmJ0eLvDRhfhVrQYHK1xvpCmmIpwZYTSPde8eMVuupaOWAVLVQQdRXeRXNf5HyI3Am+2vMUOMIiaoNFljxyXRIVblkBKqwI5rMiAhRCRCvSBXPickxYClIrDn+RKCB2xP3anEOzXisvuNTtcuHnKpGDooiQ/37ADb3vy3BUgvTKQEk+ZxzRZA3LLHBMrGnS54QpzVVPJROjELkS7TC0fINYYgdLzv2tj4zkuS62BGUEwQBAsdjj4IlALUBCCyGGQC2GTmxFz/F/Bsr3q6sq/iKPMLGuSXqh81Y8qWGFYVg95gI31pCF46o1ubGwznScR32KhVT4FzGIysTnuKFyrFwGOLx5vqiDrYhMdtaGAYshmigimFD5UmUZt7Inxb3Ox1NhzATLGWWCVlUACV/hQLMDl0RoFyr0RYOUNNCmD2dShIGFQIaAvrMZt+1nMW51ngwPBkEIGNRCIljLr/VAwKQ+6T3IGwZysUj4ZHmlJBM0GSW1KGI4lSLdM1BsBNHv+1nqAadh4Ns+WAPjDAx8AhMDMJzmHBNjs7K6v9YJtE69HokiY9BwWqvnyinvm+W/8fqm8YWYiKhMxseReaybOw0omueM+w7TPZHC4oyGyRL+TgTgEiF+c2VVfVF0GVgmj6bwIxYivOCkiwtiLuJPb67UM7tiAhRS7F7+y8Kpm+PtuJiPT2uURVJSPikyh2QxMJQVdR9OIjFGhFCANokQ42aMKA6QpgkajRhpRgZEiKgeYqRRQ6MRIK6FXM8l7c1BSucrpcKhUa+jPXcWgjhws8bwLyV9Tb9IOCbCVqgQ5pVSAy5+LtCs1ZD1U04sT7t95nQu1QhqDTSaLeie161IryRCJC7cz/Nd6BhcwTU3VSTNh/bonoiIm7hwt8P3GJIOmhs4TqdsfHFhCQnfMcBo/k27Pc/FNJnDSuGLa0rFOchc0NNovm8iUFo+NBdIE4BrKTpetI6bUmifcCXybvDCnTOmf05aWKwm5X8Xbh2l1PK0smisrp6awP1w+O5yX1cz1Ar/kvV49gG7Z7Wq+rdAb36eH1mtUcfUqXchMg3tNBfwIW400mpxj183O4vpyalBfmu7zYDSiS1bfL1nB3Rm5jE2Pg7T7mLzhgmk/QTJzDzqW7Zg6rXXPMolF5uGHnotxsjGDUxkx197Fbt37cGGegydZsyVs04HvbNngZlZbk/Rao3B9JISjPDc009xJl8kJCZPn+JbGh8fh1QBw/CJuHW3i7mZs9g0McGun6Sf4ORbb3nXTRCi0agjbDaR9fvsQaD3abeH6dkZbJiYgEgzSBLv1iFtz+Pku++iWW8wEBhKcX6LcZbFYjY7j06n6zsuBRI9GK7Ns2nzFmS5GrMg/2VVBHD+IaW8fzW/XxUBCiEecvYcsdtFfSkGDWiKT11FlRkcpz7S4j5sJ99+Ew//8PsYyeu1aG0YtvXpz38e9STDiy88z174sdExjIxvRH+ujdNTk7j7rruwa9cuzEzP4Pt//23ccOwYdm7fzgiXN958Bbbfx54gxKuvvMrW8vFXXsXWHdu5DByd69DRm/HSc8/jxeeehe72cfjQYW6dj0Dg1SefxjPPPYcd23dwvPfM5CR3tfz4L36W84D/6qt/gV/7tV9j7P4LTz7DRtjmvKwILQoVhOjMn8ULTz6FI8eOYcPYBrz02BP48T/+I/Zccw0bZu+cOIGJ8XE8+NGPIqxHXDh98q138J3vPcQhr1tuuw0y8gv84Ye+zxC0uFFnlaWXJuzcv/OB+1ld+PFPfoLJN97Chi2b0dEpVLOGPfv3YWLzliXibjmD6UIG0chqfr/qipJCLu+cXkyARclXbSoJQwWCtTyC80H+KGSxvXHjBtx2xx1obRxjonzuqaeYa4S5cXPjzUdx+OBBONIv+wm+9Z3vsHuDe20EEVvIJ155DVOnTuMDd93FnLKbJFyh4M67P8haT9Lp4sidd2Hr9h1Ar4v5+Q5mTryLT3/mF/Gdv/kmtu/chY2jozCpxmijia3jE5xy4JTCxtExnDoz6es7CwnT6TKGkbiT1AZR6DPk8psGyFokkZpmzPmJ44/V6ji4bx/u/tCHyVzlPnP/8Hd/i1dffhk3XH89z8frL72Mu2+/HU8+9RS6hw6h0RKQtQYDb48eOoy9x44BScKi9P/7/d/H7qt2YNfB6xBahx3btnPmnowDbNq6FbWRZm6EqJzoZDHzeb+B9Rnn8/kNG2s9+/+2ooMX6Ye5lSiKrHBXzRAftClgxdv4ojj9uXmuaHXddYfh+qlve28FEsNWC0ynn0OcAiAIYRJvyTabLdx0192c5/u1P/1zTiyy3IoSSNrdPP/X9+YwZ+f4Gl594XlMbBxjcbtz21a8+PijrLsJX6sL/fk51EhvNCliOK79TNzNdtuIQsU+T2QphNVciIkMIG4WTApdmnIpX/pcsprgc0585QjH+SOy32Wnbn92lkXq7Dtv4+TJE9ixbRt27tyBh7/7HXai2848xkZbbM37apkBc+F9+67F9NQUf6ZINSC6nz2L/vRZCFoITjDxSyfyFIOihaO4UDTbYppYdahljS37xa+fyy0zzFEp8j4ectheJK5Jec99iKjHqI2NIao38Ed/+qcM4Qo2buKfsnuBFP5NmyBbIwzhZ90ozdiwYSe1ksxFjx29ieH/QS2GqMeQUQgdBpjvdWE6HbZ057TGu++8hTdPvIO//7tv4sTpk3j1tdfwzswUJHFhAWzYczXGjxzGxIF9aO3bi37S41owstlAkqVcS4aIwUnBC8ib3w4gYgwkXCBYp+VaZApI7eA9kh50s45XX38VW/ZcDaQ9/OH/+4cY3bgBf/vtv8P0zDSeePZpTJ94h89HIrc5NuKJm3TZ+Xk89sRjOHzkMP9NIn/7jquw97bbcc3RY4hHx7hIpkdli7IPcTHv61WgSyn162vZb82dkqSU8nxEWPiHQjWChCxSiLzouEViEsRcFMixi0A4y+gS4uLf+POvctsDsic3jY1xYL0/OcVe+GefeAIvPfMMtmzdgpkz0+xb9Jlfiq3s+sZRbho4229j+6EDuMNq9HpdZP0OHD3wrI+Jq3dwXWjXamD21ZexY98+HDp4kOsMZhB4+amn0Jmdhet0kEiBk6dP4Xvf/BvutknK/chV2yBbLX6o23btQlxvMPE3N25ilMv017/u01GNxV13383GSGPTOBB7p61qtbi9/ze+/nW+36mpKa6HuH3nTrz4yiu4/6Mfww033wRJv7cWt913Hx761rfxz7ZtxYbxcfz46afx7MsvMxF2kz5u+eAHoUZHuBO8CCVeOP4qjp88iV7aY4/EngMHsP/wYS90WAXKi7nnAFu5esa1YKwk4rHcuCD6d84dBfDYkM8XvAprkJKlS8T2/7N3dbFxXFX43L+Z3Vl7bWMCSuuqtVVUNUVpifoAT/CEhMQTUioQPw8FCVTxQFVQpaovSATlpRFSEbxEBVUIlSceeChSX6KiCiEU0SRtoihFiUuJYxdjx+tdz87MvRedc+/szu7aiXe966wdjrTa9e54Z3bmzDn3nvt93xGCUiImt7Bcce1FuaU0ZXUKabzp9PO0Bp241gmYckpB6ArGvkyTGU1NoomdJyQ0N2skmGmo6OqIM+joBBQlmJiFrbhJ8iFxHFOAktJ1z8ybL6qoDJsbNVJz0HlRVXAqJcmoAjbeAlBOMN0KReOn2sY6VKemqVkNbcsV1flwlpw0m06/EIcMmDZpeRFI9Mho40j1OFxMMl+6AuKSADPAhOMVZxjthYTa+hpMTc1AXNskNiEzQA5KOl7GEneFbvBEAzeue0BrqkfdPzmJtJNSA3Ppt9XxypqBx2Kc8xOMsX8M6kN7DsDW2hsA8HDXex3P6IA6FzFnHCwXRGpXYck5oKS1I4pSWRITsCCub4HCC+fTayVya6444RCeExEEDn2CkxO8oJj6Yu0q/vhemmZUMwtIhTXztFBDfwvSoW5AqRSQgHigAoIvSeW2DUoO5ZLqFMrlyHUB4A7BSmQlX+9mAoiE5DRrNKmwBmFAr3EWr0gdX7QJUa5a59vdOhYatargbvmMSE04ZM2Mc0CHiqVWszgBEQSscKmWCtueoEWq/TiMscQVbQ/svG6iIT608IAO3qUCMbADLgoh5vcyjNzzFIgx9shutst7BkOh+Glwhpx6LJuUoEplz9HICL7VzDKob21RPe725ibUt2JItIZG7JbUkiyjFIzP+P7GVoO2RWfAbapTVc/ldRCvKIpIdaHFqZCCgAw4cG+mGoJymaJzUIpIhqMeN0nAXJYjunggJCkhMJzEgKBngRFPW0D/FyJw/2sZgVyVCin64WtN2zD3tzbEO8HX1KiGHB2zQwCMSXIQbfE3JPS3kCXyKYyKVioQQUgTMQuC9mtxDIPfawG2sgQMDjVwgkLjUje5M7Z95lkXsHdQE0I8stc5zNAqQcXxYHcE5Hj3NxPQcUz6z0IoyKwhfoXCSMMMzSS54rDx31VaMXCRwaFdoLDQnvMoVKCooOu6VWqfTRghcIJQUdrCiJUkCUVC5Vdk8ohTq29CJYogS50OYJYZmJquQr2BDs/J2avVKh2fVAFdRIys1GaVS0KNpammlZXEI0YcxErQCkR+oT18xs/CWEuFwf0WQ/vijNF3YNp2snaMfk+cpA7kimkzS2kFxWSYORRpXeNNaMC0iFLghxOWliFF+6Y34L+/1LrqRfKq20N/40DhWrPveQI9zHat8o4ag3jhC7qAJAaUF7WFpEIrpiFMgeSkHAfIgrB2hropOeQFpRFtnFgQjiVp5uvSqskyp8zAJKSeEI8WyoDKONFEBRqbdUqRUVAmcGkp4LRqsaVj2LhdI06HTg1EYRnCwIufZ75sQuAHSZ3g8ZlJTq8lRkTrUjEYP/KiNWjrq0xuEZ97crwhcac2dRnTI+nKeHAGHitGSOoeYAylX4qUONkOuSeyuF51eG40pnbBPIlK+JTs1t8loVO8MPw20LI2+nH3xqmONZzqzdAckDGmrbXHAeBi4T33Ak+MAmA6oLSb0l3qIkIWN0FFkUtrNgMZRtDINiki4f2N0SQMlW/v7/2b6J+aanDkmEo4h/Xrz1o7AEDgO67TxQADmcnIyXEshhFUp9Qwn8amGE0UFZe9YhYx4wRFEqd/KDrCBq2l+skEKS4YF0lxBzj2ozXhgPcgbGwBOQ4eR0g3oy+LYmARkjlJD8a66J051cB/p3XHoLw/2EIhjiY43sU4z9Er20W5bblCOxrn/Dhe6/68Y2cb+mKMtfZnPSpbhJIxdMFxtoh3OL4n/Ews9FwJ8NrMGxsboLMEApOr6/V7ELvf1FjH/yVcInfCmdzLDoeliscv8h6e7z4L3Bd2vI2xXX08DDslhHh5eF83otNojLnQyYSyjnCUZc4JUxcBuS9YB5WK74xuqTxTr2+SdszADrhLyyGA1kcap40iCOAQlEKCibkoPiYOeG/tkhBiR3bboDaSRhCc8yc9Joys3U640JujyFWh8gy0BumOJbdPbUy7FFZx0C+V9EjtXuGF0d0OY20fjsL5YJQd0xkj/OCNrvd6VO3Bl2PysQi+vd8i3rawfIiTIBJW34mvsVcphoNnN/rB9/VrIw0zjLH5YiQEr5ja3Qq0ky7IPLFmlEdWNNd/zuBQTwrXBb5Qs2xvdV9Gvw99oXlkNvI85yPhJdvujdBqGpNbm0zuD4o+dypUtqth9rAtj37A2mI/zBOFirWyDqL50I9iLO3SKCNfbvsy0MKpe5ZlbWlWLwlR5BakjQbVwZgfG0ZRuQVoaLfyH/6l5y3eg6JSTLt0xDrUkVp7vj/S76lRjfm6rS8HvHDhwme11q9aa3+9srLylZ22W11dfeLKlSsdS3RhWH6ZMd36UUU9O7K8EFb4vJPF1beW0a7M+PaxOPEgiiFvM796+Gr3gfNhsBh2qeVO1tcptda+mlErIPiT1nqxVCpt21AsSZJXlFIVAHiOMWa6vkOAMZlNU9Lko6U143i1MgxAhE4nRmcJJBs1SJNmC1eYqwkMy1oL8lISFEyGIZWHaELC8/IL61E5gN5FhUNhnHM5zCLzrvbZ5/ai2WzGUspz6HzPP/98Ocuyk8vLy99pNptff+eddz4Fbp2QVlieeeaZ0FrLTp8+PdVoNL6xurr6vSRJTl69dq2KDpf5+ptm4Nvx644WDDnxp4P3OnRzTXe4j8aso+tmgfEH7cdhNCEE22/ngwEi4K+MMaZWq/1rc3Pz7ZmZma+WSqWZ69evvzU3N/d5pdTk5cuXf3rs2LGXOOcl9K1bt279ZnZ29pv4A1dWVv48Ozv7ZSFE6cqVKz954vHHb8b1xqQKFDVQicplEvyhNVMwoJsJbG3cbgneDLupCy1oCQFBxcGtqPaXdztyRaGcJt/heMzu0+B5f2zRo1ruifV9HrXWWaVS+VulUvl0FEWf3NjYeOPRRx/943vvvfcLzjmbnZ190m+K1/CHR44ceVIpVV5cXDxz9OjRNy9evPhL3C6O4zng/PeiFP4hqTcg4F5areVk3K+OMB8U2e6L0/ZOdRPW8UAHlF5DxXjRSTcD79TZZV3Ph8E45yfupfPBIA5ojGlKKd+emJggwbkXX3zxMj4//fTTt/D5gw8+mCxun6fj119/fdVv909wTe8ewOt5/vz5N6PZTzAaf1kg2LvJnCQa4w4jyFXgMXeWUDDtPuoFFp4t8E7yuNUi4Th8HiHASGhc0E/HQ1PSYfAYV4QuRf939wB3D++Ixe8/DE7oU+7ASOZh2V4yCSFJz5w58zm83u++++5n8Pn48ePreao8d+4cT9OUlCRfeOGFh3A8eO3atS8YY1i1Wl3EGNVsNul7ytVJHPe/QgKVmUOIUEcmGQJnkkAKjlfDe6IY9PzVfteRcHLlmTyikm4BAUjxQUAqnjtmIToW/rN3jwfWXtkLh2PY1q8DmizLKDG99tprf200Givlcvlr6+vr3z127NgPjDGpEOJio9H4GK/TU0899dzVq1f/kiTJ6sTExI/W1ta+v7Cw8C0MgNPT0zfBpYGWilI0Pf3jyswUc2r77clIuyX/3Q+ww0kK3pKXfDKjHbgUZ93Srfn2utf2OxqbqzagCSH4oOy1UVlfeMClpaXfxnGcLCws0ISwXC6fPnny5ImlpaVobm7u2s2bN99/7LHH/mOt/d3y8vJCpVLRSqmVs2fP/vzZZ589UavVgsnJyfc/+uijv8/Pz8dLS0tvrK2tne/eTzARMbuVfhE4O4cTEiIhad4hlngn2w48UGywksuVkfOJQzSd2ME451/qV7Fgv2zsb2rTzG5Aljxcb9ScWCIXrS5KbTSvbfGNO+GVbfINp94fTrFKSkXC4jT58D19x/9MDGQf7sdy2l5smJD8kRgPJc3S6qsf41hRuQi48/bFj4qlE0fMMW3Ei1KeGtArinkILPX6fGO/bD32DphbZfYIsbpry7d21KzuOdus9z1GkHfXeIY+wwnT4UnDd9VkHjc7sLf+7aV/2+4UbLsUn2zRT70GDXUsL0ckd5a3FgMhD/CZcDZOM9t+7MDe+lNHH2TVow8y34XnjmZ9w2pS+AyUozq2xJH253hHZJfQ8Q6q88FBjoDdtnb9+rQM5Vp3BMxTsLHWtS2oRK4PnPYLbpy7SHmAzgTnfGbQfn7jZgc2AnbbzPz8+uQDD7Hq0YeYYXC2Q3wRZ8FK0oPlaJpC4+sDYmfzaHdYnA8OUwTcydZv3XwJwJ4qTUyQfjT3wpKuT7AT6rFmbM/Ey0KIU/f6IEZp43naR2TWrk0nW3KFC6lIbCgXaBwfB8w450cOU4S7mx2aFLwbY2xmPYwmAxWWGWEvuWDGwlmSQt1/08W06h/qfnK+/9sdLMuybxtj3tJaN7TWdsBHw1r7Fn7Xvf4942r/CwAA//88+nPYFQ+DBwAAAABJRU5ErkJggg==" alt="Logo">
    <div class="title">Relatório de Conferência — Notas Diferentes</div>
  </header>
  <div class="meta">
    Empresa (destinatário): <strong>${meta.companyName}</strong> — ${meta.companyDoc}<br>
    Gerado em: ${new Date().toLocaleString()} • Total de notas diferentes: <strong>${rows.length}</strong>
  </div>

  <div class="section-title">Notas para conferência do cliente</div>
  <table>
    <thead><tr>${headerCols.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${bodyRows || `<tr><td colspan="9">Não há notas diferentes.</td></tr>`}</tbody>
  </table>
  <script>
    // Abre diálogo de impressão automaticamente
    setTimeout(function(){ try{ window.focus(); window.print(); }catch(e){} }, 300);
  </script>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w){ alert('Permita pop-ups para visualizar o PDF.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

// ---------- DANFE Pro ----------
function danfeHTML(x){
  // helpers
  const fmtDoc = (d)=> {
    const s = (d||'').replace(/\D+/g,'');
    if (s.length===14) return s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2}).*$/,'$1.$2.$3/$4-$5'); // CNPJ
    if (s.length===11) return s.replace(/^(\d{3})(\d{3})(\d{3})(\d{2}).*$/,'$1.$2.$3-$4'); // CPF
    return d||'';
  };
  const money = (v)=> {
    const n = Number(String(v).replace(',','.'));
    if (Number.isFinite(n)) return n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
    return v||'';
  };
  const dateBr = (s)=>{
    if (!s) return '';
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
  };
  const chave = digits(x.key||'');
  const chaveFmt = chave.replace(/(\d{4})(?=\d)/g,'$1 ').trim();

  const css = `
  @page { size: A4; margin: 12mm; }
  body{ font-family:Segoe UI, Tahoma, Roboto, Arial, sans-serif; color:#111; }
  .box{ border:1px solid #000; border-radius:4px; padding:6px; margin-bottom:6px; }
  .row{ display:flex; gap:6px; }
  .col{ flex:1; }
  h1{ font-size:18px; margin:0 0 4px; }
  .muted{ color:#555; font-size:12px; }
  .grid2{ display:grid; grid-template-columns:1fr 1fr; gap:6px; }
  .grid3{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; }
  table{ width:100%; border-collapse:collapse; font-size:12px; }
  thead{ display:table-header-group; }
  th,td{ border:1px solid #000; padding:4px 6px; }
  th{ background:#eee; }
  td.r{ text-align:right; }
  td.c{ text-align:center; }
  .barcode{ width:100%; height:52px; }
  .logo{ width:48px; height:48px; border-radius:8px; }
  .header{ display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
  .header .left{ display:flex; align-items:center; gap:8px; }
  `;

  const itens = (x.dets||[]).map((d,i)=>`
    <tr>
      <td class="c">${i+1}</td>
      <td>${(d.xProd||'')}</td>
      <td class="c">${d.CFOP||''}</td>
      <td class="c">${d.uCom||''}</td>
      <td class="r">${(d.qCom||'')}</td>
      <td class="r">${money(d.vProd||'')}</td>
    </tr>
  `).join('');

  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>DANFE — ${x.nNF}/${x.serie}</title>
<style>${css}</style>
</head>
<body>
  <div class="header">
    <div class="left">
      <img class="logo" src="data:image/png;base64,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" alt="Logo">
      <div>
        <h1>DANFE — Documento Auxiliar da NF-e</h1>
        <div class="muted">NF-e nº <strong>${x.nNF||''}</strong> — Série <strong>${x.serie||''}</strong> — Emissão <strong>${dateBr(x.dhEmi)||''}</strong></div>
      </div>
    </div>
    <div class="right">
      <svg id="barcode"></svg>
    </div>
  </div>

  <div class="box">
    <div><strong>Chave de Acesso:</strong> ${chaveFmt || '—'}</div>
  </div>

  <div class="grid2">
    <div class="box">
      <strong>Emitente</strong><br>
      ${x.emit?.name||''}<br>
      Doc: ${fmtDoc(x.emit?.doc||'')} • UF: ${x.ufEmit||''}
    </div>
    <div class="box">
      <strong>Destinatário</strong><br>
      ${x.dest?.name||''}<br>
      Doc: ${fmtDoc(x.dest?.doc||'')} • UF: ${x.ufDest||''}
    </div>
  </div>

  <div class="grid3">
    <div class="box"><strong>Número</strong><br>${x.nNF||''}</div>
    <div class="box"><strong>Série</strong><br>${x.serie||''}</div>
    <div class="box"><strong>Valor Total</strong><br>${money(x.vNF||'')}</div>
  </div>

  <div class="box">
    <strong>Itens da NF-e</strong>
    <table>
      <thead>
        <tr>
          <th>#</th><th>Descrição</th><th>CFOP</th><th>Un</th><th>Qtd</th><th>Valor</th>
        </tr>
      </thead>
      <tbody>
        ${itens || '<tr><td colspan="6" class="c">Itens não informados no XML.</td></tr>'}
      </tbody>
    </table>
  </div>

  <!-- JsBarcode CDN e impressão -->
  <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
  <script>
    (function(){
      try{
        var key = "${chave}";
        if (key && window.JsBarcode){
          JsBarcode("#barcode", key, {format:"CODE128", displayValue:false, height:48, margin:0});
        }
      }catch(e){}
      setTimeout(function(){ try{ window.focus(); window.print(); }catch(_){} }, 400);
    })();
  </script>
</body>
</html>
  `;
}

function openDANFEWindow(x){
  const w = window.open("", "_blank");
  if (!w){ alert("Permita pop-ups para visualizar o DANFE."); return; }
  w.document.open();
  w.document.write(danfeHTML(x));
  w.document.close();
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

  // Linhas (detalhadas) para as tabelas/relatórios
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

// ---------- DANFE (lista e abertura) ----------
function danfeCardHTML(x, label){
  return `
    <div class="danfe-card">
      <h4>${label} — Chave ${x.key}</h4>
      <div class="meta"><span>NF: ${x.nNF}</span><span>Série: ${x.serie}</span><span>Emissão: ${x.dhEmi}</span><span>Valor: R$ ${x.vNF}</span></div>
      <div class="row">
        <button class="btn primary" data-key="${x.key}" data-side="${label==='SOMENTE_EMPRESA'?'A':'B'}">Abrir DANFE</button>
        <a class="btn secondary" target="_blank" rel="noopener" href="https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?tipoConsulta=resumo&tipoConteudo=7PhJ+gAVw2g%3D">Consultar na SEFAZ</a>
      </div>
    </div>
  `;
}

function showDanfeModal(){
  const modal = el('danfeModal');
  const listEl = el('danfeList');
  const { mapA, mapB, onlyA, onlyB } = (window.__cmp || {});
  if (!mapA || !mapB){ alert("Faça a comparação primeiro."); return; }

  const cardsA = onlyA.map(k => danfeCardHTML(mapA.get(k), 'SOMENTE_EMPRESA')).join('');
  const cardsB = onlyB.map(k => danfeCardHTML(mapB.get(k), 'SOMENTE_FSIST')).join('');
  listEl.innerHTML = `<div class="danfe-list">${cardsA}${cardsB || ''}</div>`;
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
