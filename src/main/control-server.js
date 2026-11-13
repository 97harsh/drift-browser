// Drift's control plane: a token-protected HTTP server exposing
//   GET  /health                 — liveness (no auth)
//   GET  /api/tools              — tool catalog with JSON schemas
//   POST /api/tools/:name        — run a tool (JSON body = input)
//   GET  /api/state | /api/usage — browser state / Claude API usage
//   POST /mcp                    — MCP (streamable HTTP, stateless) with the same tools
// Optionally published to the internet with a Cloudflare quick tunnel.
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { runTool, jsonSchemaOf } = require('./tools');
const { summarizeUsage } = require('./util');

class ControlServer {
  constructor({ browser, store, tools, version }) {
    this.browser = browser;
    this.store = store;
    this.tools = tools;
    this.version = version;
    this.server = null;
    this.tunnel = null; // {proc, url}
    this.status = { listening: false, error: null };
  }

  get cfg() {
    return this.store.s.settings.control;
  }

  authed(req) {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : new URL(req.url, 'http://x').searchParams.get('token') || '';
    const a = Buffer.from(tok);
    const b = Buffer.from(this.cfg.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  start() {
    if (this.server || !this.cfg.enabled) return;
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => send(res, 500, { error: e.message })));
    this.server.on('error', (e) => {
      this.status = { listening: false, error: e.message };
      this.server = null;
    });
    this.server.listen(this.cfg.port, this.cfg.host, () => {
      this.status = { listening: true, error: null };
    });
  }

  stop() {
    this.stopTunnel();
    if (this.server) this.server.close();
    this.server = null;
    this.status = { listening: false, error: null };
  }

  restart() {
    this.stop();
    this.start();
  }

  rotateToken() {
    this.cfg.token = crypto.randomBytes(24).toString('hex');
    this.store.save();
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version');
    if (req.method === 'OPTIONS') return send(res, 204);
    if (url.pathname === '/health') return send(res, 200, { ok: true, name: 'drift', version: this.version });
    if (!this.authed(req)) return send(res, 401, { error: 'Missing or bad bearer token (Drift → Settings → Remote control)' });

    if (url.pathname === '/mcp') return this.handleMcp(req, res);
    if (url.pathname === '/api/tools' && req.method === 'GET') {
      return send(res, 200, { tools: this.tools.map((t) => ({ name: t.name, kind: t.kind, description: t.description, input_schema: jsonSchemaOf(t) })) });
    }
    const m = url.pathname.match(/^\/api\/tools\/([a-z_]+)$/);
    if (m && req.method === 'POST') {
      const body = await readJson(req);
      const blocked = await this.purchaseGuard(m[1], body);
      if (blocked) return send(res, 403, { ok: false, error: blocked });
      const r = await runTool(this.tools, m[1], body);
      return send(res, r.ok ? 200 : 400, r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error });
    }
    if (url.pathname === '/api/state') return send(res, 200, this.browser.serialize());
    if (url.pathname === '/api/usage') return send(res, 200, { summary: summarizeUsage(this.store.s.usage), entries: this.store.s.usage.slice(-200) });
    return send(res, 404, { error: 'not found' });
  }

  /** Remote callers cannot approve purchases; refuse those clicks outright. */
  async purchaseGuard(name, input) {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool || !tool.sensitive) return null;
    const parsed = tool.schema.safeParse(input || {});
    if (!parsed.success) return null;
    try {
      const reason = await tool.sensitive(parsed.data);
      return reason ? `${reason}. Purchase steps must be done by a person in the Drift window.` : null;
    } catch {
      return null;
    }
  }

  buildMcp() {
    const mcp = new McpServer({ name: 'drift-browser', version: this.version });
    for (const tool of this.tools) {
      mcp.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.schema.shape,
          annotations: { readOnlyHint: tool.kind === 'read' },
        },
        async (args) => {
          const blocked = await this.purchaseGuard(tool.name, args);
          if (blocked) return { isError: true, content: [{ type: 'text', text: blocked }] };
          const r = await runTool(this.tools, tool.name, args);
          if (!r.ok) return { isError: true, content: [{ type: 'text', text: r.error }] };
          if (tool.image && r.result.image) {
            return { content: [{ type: 'image', data: r.result.image, mimeType: r.result.mediaType }, { type: 'text', text: r.result.url }] };
          }
          return { content: [{ type: 'text', text: JSON.stringify(r.result, null, 1) }] };
        },
      );
    }
    return mcp;
  }

  async handleMcp(req, res) {
    if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null });
    const body = await readJson(req);
    const mcp = this.buildMcp();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  // ---------- Cloudflare quick tunnel ----------
  cloudflaredPath() {
    for (const p of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) {
      try {
        execFileSync(p, ['--version'], { stdio: 'ignore' });
        return p;
      } catch {}
    }
    try {
      return execFileSync('/bin/sh', ['-lc', 'command -v cloudflared']).toString().trim() || null;
    } catch {
      return null;
    }
  }

  startTunnel(onChange) {
    if (this.tunnel) return this.tunnel;
    const bin = this.cloudflaredPath();
    if (!bin) {
      this.tunnel = null;
      return { error: 'cloudflared is not installed. Run: brew install cloudflared' };
    }
    const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.cfg.port}`]);
    this.tunnel = { proc, url: null, starting: true };
    const scan = (buf) => {
      const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && this.tunnel && !this.tunnel.url) {
        this.tunnel.url = m[0];
        this.tunnel.starting = false;
        onChange && onChange();
      }
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);
    proc.on('exit', () => {
      this.tunnel = null;
      onChange && onChange();
    });
    return this.tunnel;
  }

  stopTunnel() {
    if (this.tunnel) this.tunnel.proc.kill();
    this.tunnel = null;
  }

  info() {
    const local = `http://${this.cfg.host === '0.0.0.0' ? '127.0.0.1' : this.cfg.host}:${this.cfg.port}`;
    return {
      ...this.status,
      enabled: this.cfg.enabled,
      local,
      tunnel: this.tunnel ? { url: this.tunnel.url, starting: !!this.tunnel.starting } : null,
      token: this.cfg.token,
    };
  }
}

function send(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = { ControlServer };
