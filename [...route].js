const crypto = require('crypto');

const receipts = globalThis.__bonlyReceipts || (globalThis.__bonlyReceipts = new Map());
const terminals = globalThis.__bonlyTerminals || (globalThis.__bonlyTerminals = new Map());

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
function now(){ return new Date().toISOString(); }
function token(){ return 'BN-' + crypto.randomBytes(8).toString('hex').toUpperCase(); }
function tx(){ return 'TX-' + crypto.randomBytes(7).toString('hex').toUpperCase(); }
function euro(c){ return (c/100).toLocaleString('de-DE',{style:'currency',currency:'EUR'}); }
function read(req){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>resolve(b));req.on('error',reject)})}

module.exports = async function handler(req,res){
  if(req.method==='OPTIONS'){res.statusCode=204;res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type');return res.end()}
  const route = Array.isArray(req.query?.route) ? req.query.route.join('/') : String(req.query?.route||'');
  try {
    if(req.method==='GET' && route==='health') return json(res,200,{ok:true,service:'bonly-vercel-api',version:'1.0'});
    if(req.method==='POST' && route==='checkout'){
      const body=JSON.parse(await read(req)||'{}');
      const amountCents=Number(body.amountCents||1847);
      const items=Array.isArray(body.itemsList)&&body.itemsList.length?body.itemsList:[{name:'Beispielartikel',quantity:1,unitPriceCents:amountCents}];
      const t=token(); const id=tx(); const purchasedAt=body.purchasedAt||now(); const expiresAt=new Date(Date.now()+10*60*1000).toISOString();
      const receipt={token:t,transaction_id:id,merchant:body.merchant||'LIDL',branch:body.branch||'Filiale 482',register:body.register||'Kasse 03',terminal_code:body.terminalCode||'BONLY-LIDL-482-03',amount_cents:amountCents,amount:euro(amountCents),item_count:items.reduce((n,i)=>n+Number(i.quantity||1),0),purchased_at:purchasedAt,expires_at:expiresAt,items:items.map(i=>({name:i.name||'Artikel',quantity:Number(i.quantity||1),unitPrice:euro(Number(i.unitPriceCents||0)),total:euro(Math.round(Number(i.unitPriceCents||0)*Number(i.quantity||1)))}))};
      receipts.set(t,receipt);
      terminals.set(receipt.terminal_code,{merchant:receipt.merchant,branch:receipt.branch,register:receipt.register,status:'online'});
      return json(res,201,{ok:true,checkout:'completed',receiptToken:t,transactionId:id,amount:receipt.amount,merchant:receipt.merchant,branch:receipt.branch,terminalCode:receipt.terminal_code,register:receipt.register,expiresAt});
    }
    if(req.method==='GET' && route.startsWith('receipts/')){
      const t=decodeURIComponent(route.slice('receipts/'.length)).toUpperCase(); const r=receipts.get(t);
      if(!r)return json(res,404,{error:'receipt_not_found'});
      if(new Date(r.expires_at)<new Date()){receipts.delete(t);return json(res,410,{expired:true,token:t})}
      return json(res,200,r);
    }
    if(req.method==='GET' && route==='terminals') return json(res,200,[...terminals.entries()].map(([terminal_code,v])=>({terminal_code,...v})));
    return json(res,404,{error:'not_found'});
  } catch(e){ return json(res,400,{error:'request_failed',message:e.message}); }
};
