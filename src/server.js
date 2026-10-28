'use strict';
/**
 * Verification API + dashboard (node:http, no framework).
 *
 *   GET  /api/status          gateway, contract, chain and counts
 *   GET  /api/readings?limit  latest readings with batch status
 *   GET  /api/batches?limit   latest batches with transaction details
 *   GET  /api/verify/:seq     verify one record against the chain
 *   GET  /api/bundle/:seq     exportable proof bundle for an outside auditor
 *   GET  /api/audit           verify every record; counts + problems
 *   POST /api/demo/edit       demo only: change one anchored reading in the database
 *   POST /api/demo/delete     demo only: delete one anchored reading
 *   POST /api/demo/reset      demo only: undo the demo edits (restores the rows)
 *
 * The dashboard is a convenience. An auditor who distrusts it can run the same
 * checks with verifyBundle() and any RPC endpoint.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');

function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body, null, 2) : body;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

function createServer(sys, { allowDemoTamper = false } = {}) {
  const saved = new Map(); // seq -> original row, so demo edits can be undone

  const routes = {
    'GET /api/status': async () => ({
      gateway: sys.wallet.address,
      contract: sys.contractAddress,
      chain: sys.chain.info,
      chainId: sys.chain.chainId,
      batchSize: sys.gateway.batchSize,
      batchIntervalMs: sys.gateway.batchIntervalMs,
      openBatch: sys.gateway.buffer.length,
      counts: sys.db.counts(),
      demoTamper: allowDemoTamper,
      tampered: [...saved.keys()],
    }),
    'GET /api/readings': async (q) => sys.db.latestReadings(Math.min(200, Number(q.get('limit')) || 40)),
    'GET /api/batches': async (q) => sys.db.latestBatches(Math.min(100, Number(q.get('limit')) || 15)),
    'GET /api/audit': async () => {
      const a = await sys.verifier.audit();
      return { ...a, results: undefined, problems: a.problems.slice(0, 200) };
    },
  };

  const pickAnchored = () => {
    const row = sys.db.db
      .prepare(
        `SELECT r.* FROM readings r JOIN batches b ON b.batch_no = r.batch_no
         WHERE b.status = 'anchored' ORDER BY RANDOM() LIMIT 1`
      )
      .get();
    return row ?? null;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const key = `${req.method} ${url.pathname}`;
      if (routes[key]) return send(res, 200, await routes[key](url.searchParams));

      let m = url.pathname.match(/^\/api\/verify\/(\d+)$/);
      if (m && req.method === 'GET') {
        sys.verifier.reset(); // single checks always read fresh chain state
        return send(res, 200, await sys.verifier.verifyRecord(Number(m[1])));
      }
      m = url.pathname.match(/^\/api\/bundle\/(\d+)$/);
      if (m && req.method === 'GET') {
        sys.verifier.reset();
        return send(res, 200, await sys.verifier.exportBundle(Number(m[1])));
      }

      if (url.pathname.startsWith('/api/demo/') && req.method === 'POST') {
        if (!allowDemoTamper) return send(res, 403, { error: 'demo tampering is disabled' });
        if (url.pathname === '/api/demo/edit') {
          const row = pickAnchored();
          if (!row) return send(res, 409, { error: 'no anchored reading yet' });
          if (!saved.has(Number(row.seq))) saved.set(Number(row.seq), row);
          const newTemp = Math.round((row.temp - 1.5) * 100) / 100;
          sys.db.db.prepare('UPDATE readings SET temp = ? WHERE seq = ?').run(newTemp, row.seq);
          return send(res, 200, { action: 'edit', seq: Number(row.seq), from: row.temp, to: newTemp });
        }
        if (url.pathname === '/api/demo/delete') {
          const row = pickAnchored();
          if (!row) return send(res, 409, { error: 'no anchored reading yet' });
          if (!saved.has(Number(row.seq))) saved.set(Number(row.seq), row);
          sys.db.db.prepare('DELETE FROM readings WHERE seq = ?').run(row.seq);
          return send(res, 200, { action: 'delete', seq: Number(row.seq) });
        }
        if (url.pathname === '/api/demo/reset') {
          const ins = sys.db.db.prepare(
            'INSERT OR REPLACE INTO readings (seq, gw, dev, ts, temp, hum, hash, sig, batch_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          );
          for (const r of saved.values()) ins.run(r.seq, r.gw, r.dev, r.ts, r.temp, r.hum, r.hash, r.sig, r.batch_no);
          const restored = saved.size;
          saved.clear();
          return send(res, 200, { action: 'reset', restored });
        }
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });
  return server;
}

module.exports = { createServer };
