const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 8787;
const DB_FILE = process.env.BONLY_DB || path.join(__dirname, 'bonly.sqlite');
const staticFile = path.join(__dirname, 'kassenbon_app_prototyp.html');
const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS merchants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    branch TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS terminals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id INTEGER NOT NULL,
    terminal_code TEXT NOT NULL UNIQUE,
    register_name TEXT,
    status TEXT NOT NULL DEFAULT 'online',
    created_at TEXT NOT NULL,
    FOREIGN KEY (merchant_id) REFERENCES merchants(id)
  );
  CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    merchant_id INTEGER NOT NULL,
    terminal_id INTEGER,
    transaction_id TEXT NOT NULL UNIQUE,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    item_count INTEGER NOT NULL DEFAULT 0,
    purchased_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    FOREIGN KEY (merchant_id) REFERENCES merchants(id),
    FOREIGN KEY (terminal_id) REFERENCES terminals(id)
  );
  CREATE TABLE IF NOT EXISTS receipt_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    unit_price_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE
  );
`);

function now() { return new Date().toISOString(); }
function token() { return 'BN-' + crypto.randomBytes(8).toString('hex').toUpperCase(); }
function transactionId() { return 'TX-' + crypto.randomBytes(7).toString('hex').toUpperCase(); }
function readBody(req) { return new Promise((resolve,reject)=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>resolve(b)); req.on('error',reject); }); }
function json(res,status,body){ const data=JSON.stringify(body); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Cache-Control':'no-store'}); res.end(data); }
function eurosToCents(value){
  if(typeof value==='number') return Math.round(value*100);
  const s=String(value ?? '0').replace(/[^0-9,.-]/g,'').replace(',','.');
  const n=Number(s); return Number.isFinite(n) ? Math.round(n*100) : 0;
}
function centsToEuro(c){ return (c/100).toLocaleString('de-DE',{style:'currency',currency:'EUR'}); }
function seed(){
  const merchantCount = db.prepare('SELECT COUNT(*) AS c FROM merchants').get().c;
  if(merchantCount===0){
    const m=db.prepare('INSERT INTO merchants(name,branch,created_at) VALUES(?,?,?)').run('LIDL','Filiale 482',now());
    db.prepare('INSERT INTO terminals(merchant_id,terminal_code,register_name,status,created_at) VALUES(?,?,?,?,?)').run(Number(m.lastInsertRowid),'BONLY-LIDL-482-03','Kasse 03','online',now());
  }
}
seed();

function merchantFor(input){
  const name=input.merchant || 'LIDL';
  let m=db.prepare('SELECT * FROM merchants WHERE name=? AND branch=?').get(name,input.branch || 'Filiale 482');
  if(!m){ const r=db.prepare('INSERT INTO merchants(name,branch,created_at) VALUES(?,?,?)').run(name,input.branch||'Filiale 482',now()); m=db.prepare('SELECT * FROM merchants WHERE id=?').get(Number(r.lastInsertRowid)); }
  return m;
}
function terminalFor(merchant,input){
  const branchCode = String(merchant.branch || 'MAIN').replace(/[^A-Z0-9]+/gi,'-').toUpperCase();
  const code=input.terminalCode || `BONLY-${merchant.name}-${branchCode}-03`;
  let t=db.prepare('SELECT * FROM terminals WHERE terminal_code=?').get(code);
  if(!t){ const r=db.prepare('INSERT INTO terminals(merchant_id,terminal_code,register_name,status,created_at) VALUES(?,?,?,?,?)').run(merchant.id,code,input.register||'Kasse 03','online',now()); t=db.prepare('SELECT * FROM terminals WHERE id=?').get(Number(r.lastInsertRowid)); }
  return t;
}
function createReceipt(input={}){
  const merchant=merchantFor(input); const terminal=terminalFor(merchant,input); const created=now();
  const items=Array.isArray(input.itemsList)&&input.itemsList.length ? input.itemsList : [
    {name:'Beispielartikel',quantity:1,unitPriceCents:eurosToCents(input.amount||'18,47 €')}
  ];
  const amountCents=input.amountCents ?? eurosToCents(input.amount||'18,47 €');
  const tx=transactionId(); const tok=token();
  const expires=new Date(Date.now()+10*60*1000).toISOString();
  const ins=db.prepare(`INSERT INTO receipts(token,merchant_id,terminal_id,transaction_id,amount_cents,currency,item_count,purchased_at,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const r=ins.run(tok,merchant.id,terminal.id,tx,amountCents,'EUR',items.reduce((n,i)=>n+Number(i.quantity||1),0),input.purchasedAt||created,created,expires);
  const receiptId=Number(r.lastInsertRowid);
  const ii=db.prepare('INSERT INTO receipt_items(receipt_id,name,quantity,unit_price_cents,total_cents) VALUES(?,?,?,?,?)');
  for(const item of items){ const q=Number(item.quantity||1); const u=Number(item.unitPriceCents ?? eurosToCents(item.unitPrice||0)); ii.run(receiptId,item.name||'Artikel',q,u,Math.round(u*q)); }
  return getReceipt(tok);
}
function getReceipt(tok){
  const r=db.prepare(`SELECT r.*,m.name merchant,m.branch,t.terminal_code,t.register_name FROM receipts r JOIN merchants m ON m.id=r.merchant_id LEFT JOIN terminals t ON t.id=r.terminal_id WHERE r.token=?`).get(tok);
  if(!r) return null;
  if(r.expires_at && new Date(r.expires_at)<new Date()) return {expired:true,token:tok};
  const items=db.prepare('SELECT name,quantity,unit_price_cents,total_cents FROM receipt_items WHERE receipt_id=?').all(r.id);
  return {...r, amount:centsToEuro(r.amount_cents), items:items.map(i=>({...i,unitPrice:centsToEuro(i.unit_price_cents),total:centsToEuro(i.total_cents)}))};
}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type'});return res.end();}
  if(req.method==='GET'&&u.pathname==='/api/health') return json(res,200,{ok:true,service:'bonly-backend',version:'0.2',database:'sqlite'});
  if(req.method==='POST'&&u.pathname==='/api/checkout'){
    try{
      const body=JSON.parse(await readBody(req)||'{}');
      const receipt=createReceipt({...body, purchasedAt: body.purchasedAt || now()});
      return json(res,201,{ok:true,checkout:'completed',receiptToken:receipt.token,transactionId:receipt.transaction_id,amount:receipt.amount,merchant:receipt.merchant,branch:receipt.branch,terminalCode:receipt.terminal_code,register:receipt.register_name,expiresAt:receipt.expires_at});
    }catch(e){return json(res,400,{error:'checkout_failed',message:e.message});}
  }
  if(req.method==='POST'&&u.pathname==='/api/receipts'){
    try{const body=JSON.parse(await readBody(req)||'{}'); return json(res,201,createReceipt(body));}catch(e){return json(res,400,{error:'invalid_request',message:e.message});}
  }
  if(req.method==='GET'&&u.pathname.startsWith('/api/receipts/')){
    const tok=decodeURIComponent(u.pathname.split('/').pop()).toUpperCase(); const r=getReceipt(tok);
    if(!r)return json(res,404,{error:'receipt_not_found'}); if(r.expired)return json(res,410,r); return json(res,200,r);
  }
  if(req.method==='GET'&&u.pathname==='/api/merchants') return json(res,200,db.prepare('SELECT * FROM merchants ORDER BY name').all());
  if(req.method==='GET'&&u.pathname==='/api/terminals') return json(res,200,db.prepare(`SELECT t.*,m.name merchant,m.branch FROM terminals t JOIN merchants m ON m.id=t.merchant_id ORDER BY t.id`).all());
  if(req.method==='GET'&&u.pathname==='/api/receipts') return json(res,200,db.prepare(`SELECT r.token,r.transaction_id,r.amount_cents,r.item_count,r.purchased_at,m.name merchant,m.branch FROM receipts r JOIN merchants m ON m.id=r.merchant_id ORDER BY r.id DESC LIMIT 50`).all().map(r=>({...r,amount:centsToEuro(r.amount_cents)})));
  if(req.method==='GET'&&u.pathname==='/api/demo/reset'){
    db.exec('DELETE FROM receipt_items; DELETE FROM receipts;'); return json(res,200,{ok:true});
  }
  if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html')){ if(!fs.existsSync(staticFile))return json(res,404,{error:'prototype_missing'}); res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return fs.createReadStream(staticFile).pipe(res); }
  return json(res,404,{error:'not_found'});
});
server.listen(PORT,()=>console.log(`Bonly backend 0.2: http://localhost:${PORT}`));
