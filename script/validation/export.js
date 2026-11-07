// Exports a tab's finished runs as a zip the person can save: one contact sheet per run (the shop photo beside
// the front, side and back renders, with the key, name, style and silhouette score written over it) and one
// JSON file per run (the runner's record without the pictures). Runs already exported from this tab are
// skipped, so it can be called every few minutes while the queue runs. From the page's console:
//
//   const exportTab = (await import("/validation/export.js")).default
//   await exportTab(VAL, "t1")            // -> fitroom_review_t1_<time>.zip in the browser's downloads
//
// The zip is store-only (no compression), built here so nothing has to be installed. See kith_20261107/README.md.
const T=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;T[n]=c>>>0}
const crc=b=>{let c=0xffffffff;for(let i=0;i<b.length;i++)c=T[(c^b[i])&255]^(c>>>8);return (c^0xffffffff)>>>0};
function zip(files){const parts=[],central=[];let off=0;const enc=new TextEncoder();for(const f of files){const name=enc.encode(f.name),d=f.data,c=crc(d);const h=new DataView(new ArrayBuffer(30));h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint32(14,c,true);h.setUint32(18,d.length,true);h.setUint32(22,d.length,true);h.setUint16(26,name.length,true);parts.push(new Uint8Array(h.buffer),name,d);const ce=new DataView(new ArrayBuffer(46));ce.setUint32(0,0x02014b50,true);ce.setUint16(4,20,true);ce.setUint16(6,20,true);ce.setUint32(16,c,true);ce.setUint32(20,d.length,true);ce.setUint32(24,d.length,true);ce.setUint16(28,name.length,true);ce.setUint32(42,off,true);central.push(new Uint8Array(ce.buffer),name);off+=30+name.length+d.length}const cs=central.reduce((s,a)=>s+a.length,0);const e=new DataView(new ArrayBuffer(22));e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,cs,true);e.setUint32(16,off,true);return new Blob([...parts,...central,new Uint8Array(e.buffer)],{type:"application/zip"})}
const load=s=>new Promise(res=>{if(!s)return res(null);const i=new Image();i.onload=()=>res(i);i.onerror=()=>res(null);i.src=s});
export default async function exportTab(VAL, TAB) {
window.__exported ??= new Set();
const files=[];const H=480;
for(const r of Object.values(VAL.results)){
  if(window.__exported.has(r.key))continue;
  const it=r.items?.[0]??{};
  const imgs=(await Promise.all([it.photoThumb,r.pics?.front,r.pics?.side,r.pics?.back].map(load))).filter(Boolean);
  if(imgs.length){
    const W=imgs.reduce((a,i)=>a+i.width*H/i.height,0);const c=document.createElement("canvas");c.width=Math.round(W);c.height=H+28;const g=c.getContext("2d");g.fillStyle="#fff";g.fillRect(0,0,c.width,c.height);let x=0;for(const i of imgs){const w=i.width*H/i.height;g.drawImage(i,x,28,w,H);x+=w}
    g.fillStyle="#000";g.font="16px sans-serif";g.fillText(`${r.key} | ${it.name??""} | ${it.kind??""}/${it.style??""} ${it.fabric??""} sil=${it.accuracy?.silhouette??"-"} ${it.error??""} ${(r.errors||[]).join(";")}`.slice(0,220),6,19);
    const b=await new Promise(res=>c.toBlob(res,"image/jpeg",0.82));files.push({name:`${r.key.replace(/[:/]/g,"__")}.jpg`,data:new Uint8Array(await b.arrayBuffer())});
  }
  files.push({name:`${r.key.replace(/[:/]/g,"__")}.json`,data:new TextEncoder().encode(JSON.stringify({...r,pics:undefined,items:(r.items||[]).map(i=>({...i,photoThumb:undefined}))}))});
  window.__exported.add(r.key);
}
const tag=`${TAB}_${Date.now()}`;
if(files.length){const blob=zip(files);const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`fitroom_review_${tag}.zip`;document.body.appendChild(a);a.click();}
return [tag, files.length, Object.keys(VAL.results).length, VAL.runs.length]
}
