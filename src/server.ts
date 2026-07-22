import Database from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";

// Configurable via environment or auto-detected
const PORT = parseInt(process.env.PORT || "3456");
const DB_PATH = process.env.MIMOCODE_DB || join(homedir(), ".local", "share", "mimocode", "mimocode.db");

function getDb() {
  return new Database(DB_PATH, { readonly: true });
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function html(content: string) {
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// 查询顶层会话(parent_id IS NULL),附带消息/part 数量用于去重判断
function queryParentSessions(db: any, days: number, dirFilter = ""): any[] {
  let q = `
    SELECT s.id, s.title, s.directory, s.project_id, s.time_created, s.time_updated,
           (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) as msg_count,
           (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id) as part_count
    FROM session s
    WHERE s.parent_id IS NULL AND s.time_updated > ? AND lower(s.title) NOT IN ('auto dream')`;
  const params: any[] = [Date.now() - days * 86400000];
  if (dirFilter) { q += ` AND s.directory LIKE ?`; params.push(`%${dirFilter}%`); }
  q += ` ORDER BY s.time_updated DESC`;
  return db.query(q).all(...params) as any[];
}

// 按 (directory, title) 归组后消除"数据合并产生的重复会话"。
// 判定为重复的依据: 同一组内两条会话的 time_updated、msg_count、part_count 完全一致
// —— 即同一会话被复制了多份(仅 id 不同)。只有这类精确重复才会被折叠,
// 内容/时间有差异的会话视为真实不同会话,全部保留,避免误删。
function dedupeSessions(rows: any[]): any[] {
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const key = (r.directory || "") + "@@@DUPSEP@@@" + (r.title || "").toLowerCase();
    (groups.get(key) || groups.set(key, []).get(key)!).push(r);
  }
  const result: any[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) { result.push(group[0]); continue; }
    const buckets = new Map<string, any[]>();
    for (const g of group) {
      const sig = `${g.time_updated}|${g.msg_count || 0}|${g.part_count || 0}`;
      (buckets.get(sig) || buckets.set(sig, []).get(sig)!).push(g);
    }
    for (const arr of buckets.values()) {
      // 每个签名保留一份: 内容最完整、时间最新者优先
      arr.sort((a: any, b: any) =>
        ((b.msg_count || 0) + (b.part_count || 0)) - ((a.msg_count || 0) + (a.part_count || 0)) ||
        b.time_updated - a.time_updated);
      result.push(arr[0]);
    }
  }
  result.sort((a: any, b: any) => b.time_updated - a.time_updated);
  return result;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // --- API ---
    if (url.pathname === "/api/sessions") {
      const db = getDb();
      const days = parseInt(url.searchParams.get("days") || "30");
      const dir = url.searchParams.get("dir") || "";
      const rows = dedupeSessions(queryParentSessions(db, days, dir));
      db.close();
      return json(rows);
    }

    if (url.pathname === "/api/tasks") {
      const db = getDb();
      const rows = db.query(`
        SELECT t.id, t.session_id, t.status, t.summary, t.created_at, t.ended_at,
               s.directory, s.title as session_title
        FROM task t LEFT JOIN session s ON t.session_id = s.id ORDER BY t.created_at DESC
      `).all();
      db.close();
      return json(rows);
    }

    if (url.pathname === "/api/session") {
      const sid = url.searchParams.get("id");
      if (!sid) return json({ error: "missing id" }, 400);
      const db = getDb();
      const session = db.query("SELECT * FROM session WHERE id = ?").get(sid);
      if (!session) { db.close(); return json({ error: "not found" }, 404); }
      const tasks = db.query("SELECT * FROM task WHERE session_id = ? ORDER BY created_at").all(sid);
      const messages = db.query(`
        SELECT m.id, m.data as msg_data, m.time_created
        FROM message m WHERE m.session_id = ? ORDER BY m.time_created ASC LIMIT 200
      `).all(sid) as any[];
      // Fetch all parts for this session once, then group by message for robust parsing
      const rawParts = db.query(`
        SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, time_created ASC
      `).all(sid) as any[];
      const partsByMsg = new Map<string, string[]>();
      for (const p of rawParts) {
        if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, []);
        partsByMsg.get(p.message_id)!.push(p.data);
      }
      const parsed = messages.map((m: any) => {
        let role = "unknown";
        try { role = JSON.parse(m.msg_data).role || "unknown"; } catch(e) {}
        let text = "";
        let thinking = "";
        const tools: string[] = [];
        const imageByIndex: Record<number, string> = {};
        const imagesInOrder: string[] = [];
        const parts = partsByMsg.get(m.id) || [];
        for (const pd of parts) {
          try {
            const obj = JSON.parse(pd);
            if (obj.type === "text" && obj.text) {
              // 剥离系统注入提示(<system-reminder>...</system-reminder>),不要当作用户/助手真内容展示
              const clean = String(obj.text).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
              if (clean) text += (text ? "\n" : "") + clean;
            } else if (obj.type === "reasoning" && obj.text) {
              const cleanT = String(obj.text).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
              if (cleanT) thinking += (thinking ? "\n" : "") + cleanT;
            } else if (obj.type === "tool") {
              const toolName = obj.tool || obj.name || "";
              const toolLabels: Record<string, string> = { bash: "Bash", question: "提问", edit: "编辑", read: "读取", read_file: "读取", write: "写入", write_file: "写入", glob: "搜索", grep: "搜索" };
              const toolLabel = toolLabels[toolName] || toolName;
              let detail = "";
              const inp = obj.state?.input;
              if (inp && typeof inp === "object") {
                const v = inp.file_path || inp.path || inp.command || inp.pattern || inp.url || inp.query;
                if (v !== undefined) {
                  detail = typeof v === "string" ? v : JSON.stringify(v);
                  if (detail.length > 120) detail = detail.slice(0, 120) + "…";
                }
              }
              const st = obj.state?.status;
              const status = st && !/^(completed|success)$/i.test(st) ? ` [${st}]` : "";
              tools.push(detail ? `${toolLabel}(${detail})` : toolLabel + status);
            } else if (obj.type === "file") {
              // 用户粘贴/上传的图片以 data URI 形式存于 url 字段
              const url: string | undefined = obj.url || (obj.source && obj.source.url);
              if (url && typeof url === "string" && /^data:image\//i.test(url)) {
                let idx = imagesInOrder.length + 1;
                const stext = obj.source && obj.source.text && obj.source.text.value;
                if (typeof stext === "string") {
                  const mm = stext.match(/\[Image\s*(\d+)\]/i);
                  if (mm) idx = parseInt(mm[1], 10);
                }
                imageByIndex[idx] = url;
                imagesInOrder.push(url);
              }
            }
          } catch(e) {}
        }
        // 将文本中的 [Image N] 占位符替换为内联图片
        const imgTag = (u: string, n: number | string) =>
          `<img src="${u}" class="msg-img" alt="image ${n}" loading="lazy">`;
        if (imagesInOrder.length) {
          if (/\[Image\s*\d+\]/i.test(text)) {
            text = text.replace(/\[Image\s*(\d+)\]/gi, (_m, n) => {
              const u = imageByIndex[parseInt(n, 10)];
              return u ? imgTag(u, n) : _m;
            });
          } else {
            text += (text ? "\n\n" : "") + imagesInOrder.map((u, i) => imgTag(u, i + 1)).join("\n");
          }
        }
        const toolSummary = tools.join(", ");
        return { role, time_created: m.time_created, text, thinking, toolSummary };
      });
      db.close();
      return json({ session, tasks, messages: parsed });
    }

    if (url.pathname === "/api/projects") {
      const db = getDb();
      const rows = db.query("SELECT * FROM project").all();
      db.close();
      return json(rows);
    }

    // Search API: search messages by keyword
    if (url.pathname === "/api/search") {
      const db = getDb();
      const q = url.searchParams.get("q") || "";
      const limit = parseInt(url.searchParams.get("limit") || "50");
      if (!q.trim()) { db.close(); return json([]); }
      const searchPattern = `%${q}%`;
      const results = db.query(`
        SELECT DISTINCT m.session_id,
               (SELECT s.title FROM session s WHERE s.id = m.session_id) as session_title,
               (SELECT s.directory FROM session s WHERE s.id = m.session_id) as session_dir,
               (SELECT s.time_updated FROM session s WHERE s.id = m.session_id) as session_updated,
               (SELECT p.data FROM part p WHERE p.session_id = m.session_id AND p.data LIKE '%type%text%' LIMIT 1) as text_part
        FROM message m
        WHERE m.session_id IN (
          SELECT DISTINCT p.session_id FROM part p WHERE p.data LIKE ?
        )
        AND m.session_id NOT IN (SELECT id FROM session WHERE lower(title) = 'auto dream')
        ORDER BY m.time_created DESC
        LIMIT ?
      `).all(searchPattern, limit) as any[];
      db.close();
      return json(results);
    }

    // Tree API: directory → sessions → tasks
    if (url.pathname === "/api/tree") {
      const db = getDb();
      const days = parseInt(url.searchParams.get("days") || "90");
      const sessions = dedupeSessions(queryParentSessions(db, days));
      const tasks = db.query("SELECT id, session_id, status, summary FROM task ORDER BY created_at").all() as any[];
      db.close();
      // Build tasks lookup
      const tasksBySession: Record<string, any[]> = {};
      for (const t of tasks) {
        (tasksBySession[t.session_id] ||= []).push(t);
      }
      // Group by directory
      const dirMap: Record<string, any[]> = {};
      for (const s of sessions) {
        s.tasks = tasksBySession[s.id] || [];
        const dir = s.directory || "(unknown)";
        (dirMap[dir] ||= []).push(s);
      }
      // Sort directories by most recent session
      const dirs = Object.entries(dirMap)
        .sort((a, b) => {
          const latestA = Math.max(...a[1].map((s: any) => s.time_updated));
          const latestB = Math.max(...b[1].map((s: any) => s.time_updated));
          return latestB - latestA;
        })
        .map(([dir, sess]) => ({ dir, sessions: sess }))
        .filter((d: any) => d.sessions.length > 0);
      return json(dirs);
    }

    // --- Frontend ---
    if (url.pathname === "/marked.min.js") {
      const file = Bun.file(join(import.meta.dir, "..", "marked.min.js"));
      return new Response(file, { headers: { "Content-Type": "application/javascript" } });
    }

    // Favicon - return empty to avoid 404 noise
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const resp = new Response(HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0"
        }
      });
      return resp;
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`MiMoCode Viewer running at http://localhost:${PORT}`);

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MiMoCode Viewer</title>
<script src="/marked.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg0:#0f1117;--bg1:#161b22;--bg2:#0d1117;--bg3:#21262d;--border:#30363d;--border2:#21262d;--text:#e1e4e8;--text2:#8b949e;--text3:#484f58;--blue:#58a6ff;--green:#3fb950;--orange:#f0883e;--purple:#d2a8ff}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg0);color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden}
.topbar{background:var(--bg1);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0}
.topbar h1{font-size:18px;font-weight:600;color:var(--blue);white-space:nowrap}
.topbar-menu-btn{background:none;border:none;color:var(--text2);cursor:pointer;padding:4px;border-radius:4px;display:flex;align-items:center;justify-content:center}
.topbar-menu-btn:hover{background:var(--bg3);color:var(--text)}
.topbar .filters{display:flex;gap:8px;align-items:center}
.topbar .filters select{background:var(--bg2);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px}
.topbar .filters label{color:var(--text2);font-size:12px}
.theme-switcher{display:flex;gap:2px;margin-left:auto}
.theme-btn{background:var(--bg2);border:1px solid var(--border);color:var(--text2);width:28px;height:28px;border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}
.theme-btn:hover{background:var(--bg3);color:var(--text)}
.theme-btn.active{border-color:var(--blue);color:var(--blue)}
.search-box{position:relative;display:flex;align-items:center;gap:6px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:4px 10px;margin-left:12px}
.search-box svg{color:var(--text3);flex-shrink:0}
.search-box input{background:none;border:none;color:var(--text);font-size:12px;width:160px;outline:none}
.search-box input::placeholder{color:var(--text3)}
.search-clear{background:none;border:none;color:var(--text2);cursor:pointer;font-size:14px;padding:0 2px;line-height:1}
.search-clear:hover{color:var(--text)}
.main{display:flex;flex:1;overflow:hidden;position:relative}

/* left tree panel */
.left{width:420px;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;transition:width .2s ease}
.left.collapsed{width:0;border-right:none}
.left-header{padding:6px 12px;border-bottom:1px solid var(--border2);color:var(--text2);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;flex-shrink:0}
.left.collapsed .left-header,.left.collapsed .tree{opacity:0;pointer-events:none}
.tree{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#30363d transparent;padding:4px 0}
/* project node */
.proj{margin-bottom:2px}
.proj-head{display:flex;align-items:center;gap:6px;padding:6px 12px;cursor:pointer;user-select:none;border-radius:4px;margin:0 4px}
.proj-head:hover{background:var(--bg1)}
.proj-arrow{font-size:10px;color:var(--text2);transition:transform .15s;width:12px;text-align:center}
.proj-arrow.open{transform:rotate(90deg)}
.proj-icon{color:var(--orange);font-size:13px}
.proj-name{font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.proj-count{font-size:10px;color:var(--text2);margin-left:auto;white-space:nowrap}
.proj-sessions{display:none;padding-left:16px}
.proj-sessions.open{display:block}
/* session node */
.sess{margin:1px 0}
.sess-head{display:flex;align-items:center;gap:6px;padding:5px 10px;cursor:pointer;border-radius:4px;margin:0 4px;border-left:2px solid transparent}
.sess-head:hover{background:var(--bg1)}
.sess-head.active{background:var(--bg3);border-left-color:var(--blue)}
.sess-title{font-size:12px;color:#c9d1d9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.sess-meta{font-size:10px;color:var(--text3);white-space:nowrap;flex-shrink:0}
.sess-tasks{padding-left:20px;display:none}
.sess-tasks.open{display:block}
.sess-detail{display:none;padding:4px 10px 8px 22px;font-size:11px;color:var(--text2);border-left:2px solid transparent;margin:0 4px}
.sess-detail.open{display:block}
.sess-detail .sd-row{display:flex;gap:8px;margin-bottom:2px}
.sess-detail .sd-label{color:var(--text3);min-width:60px}
.sess-detail .sd-val{color:#79c0ff;font-family:monospace;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-node{display:flex;align-items:center;gap:6px;padding:2px 10px;font-size:11px;color:var(--text2)}
.badge{display:inline-block;padding:1px 5px;border-radius:6px;font-size:9px;font-weight:600}
.badge-done{background:#1b4332;color:#40c057}
.badge-open{background:#1a1e2e;color:var(--blue)}
.badge-progress{background:#2d1b00;color:var(--orange)}

/* right panel */
.right{flex:1;display:flex;flex-direction:column;overflow:hidden}
.right-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:15px;flex-direction:column;gap:8px}
.right-empty .hint{font-size:12px;color:var(--border)}
.right-header{padding:12px 20px;border-bottom:1px solid var(--border);background:var(--bg1);flex-shrink:0}
.right-header h2{font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px;display:flex;align-items:center;gap:8px}
.right-meta{display:flex;gap:16px;flex-wrap:wrap}
.right-meta .item{display:flex;flex-direction:column;gap:1px}
.right-meta .label{font-size:10px;color:var(--text2);text-transform:uppercase}
.right-meta .value{font-size:12px;color:var(--text)}
.right-meta .dir{color:#79c0ff;font-family:monospace;font-size:11px}
.right-tasks-bar{padding:6px 20px;border-bottom:1px solid var(--border2);background:var(--bg2);flex-shrink:0;display:flex;gap:8px;flex-wrap:wrap}
.right-messages{flex:1;overflow-y:auto;padding:12px 20px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.msg{margin-bottom:10px;border-radius:8px;padding:10px 12px;border:1px solid var(--border2)}
.msg.user-msg{background:rgba(63,185,80,.10);border-left:3px solid var(--green)}
.msg.assistant-msg{background:rgba(88,166,255,.10);border-left:3px solid var(--blue)}
.msg-role{font-size:10px;font-weight:600;text-transform:uppercase;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.role-icon{font-size:13px;line-height:1}
.msg-role.user{color:var(--green)}
.msg-role.assistant{color:var(--blue)}
.msg-role.unknown{color:var(--text2)}
.msg-role .msg-time{margin-left:auto;font-weight:400}
.msg-thinking{margin-top:4px;border-left:3px solid var(--border);padding-left:8px}
.msg-thinking-label{font-size:10px;color:var(--text2);cursor:pointer;user-select:none;margin-bottom:2px;display:flex;align-items:center;gap:4px}
.msg-thinking-label:hover{color:var(--text)}
.msg-thinking-label .arrow{transition:transform .15s;display:inline-block}
.msg-thinking-label .arrow.open{transform:rotate(90deg)}
.msg-thinking-content{display:none;font-size:12px;color:var(--text2);line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;padding:4px 6px;background:var(--bg2);border-radius:4px;margin-top:4px}
.msg-thinking-content.show{display:block}
.thinking-toggle{background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:3px 8px;border-radius:4px;font-size:11px;cursor:pointer}
.thinking-toggle:hover{background:var(--bg1);color:var(--text)}
.thinking-toggle.on{border-color:var(--blue);color:var(--blue)}
.loading{display:flex;align-items:center;justify-content:center;height:100%;color:var(--text2)}

/* markdown */
.md-content{font-size:13px;color:#c9d1d9;line-height:1.6;word-break:break-word}
.md-content p{margin:0 0 8px 0}.md-content p:last-child{margin-bottom:0}
.md-content ul{margin:4px 0 8px 20px;list-style-type:disc;padding-left:20px}
.md-content ol{margin:4px 0 8px 20px;list-style-type:decimal;padding-left:20px}
.md-content li{margin:2px 0}
.md-content ol li{list-style-type:decimal}
.md-content ul li{list-style-type:disc}
.md-content code{background:var(--bg3);padding:1px 5px;border-radius:3px;font-family:'SF Mono',Consolas,monospace;font-size:12px;color:var(--orange)}
.md-content pre{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;overflow-x:auto;margin:6px 0}
.md-content pre code{background:transparent;padding:0;color:#c9d1d9;font-size:12px}
.md-content strong{color:var(--text);font-weight:600}.md-content em{color:var(--purple)}
.md-content a{color:var(--blue);text-decoration:none}.md-content a:hover{text-decoration:underline}
.md-content blockquote{border-left:3px solid var(--border);padding-left:10px;color:var(--text2);margin:6px 0}
.md-content h1,.md-content h2,.md-content h3,.md-content h4{color:var(--text);margin:10px 0 6px 0}
.md-content h1{font-size:16px}.md-content h2{font-size:15px}.md-content h3{font-size:14px}.md-content h4{font-size:13px}
.md-content table{border-collapse:collapse;margin:6px 0;font-size:12px}
.md-content th,.md-content td{border:1px solid var(--border);padding:4px 8px}
.md-content th{background:var(--bg1);color:var(--text2)}
.md-content hr{border:none;border-top:1px solid var(--border);margin:8px 0}
.msg-img{max-width:100%;max-height:300px;border-radius:6px;margin:6px 0;cursor:zoom-in;display:block;border:1px solid var(--border2)}
.img-zoom-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;align-items:center;justify-content:center;cursor:zoom-out}
.img-zoom-overlay.show{display:flex}
.img-zoom-overlay img{max-width:92vw;max-height:92vh;border-radius:8px}
.msg-text.md{padding:6px 8px;border-radius:4px;max-height:300px;overflow-y:auto;cursor:default}
.msg-text.md.expanded{max-height:none}
.msg-thinking .md-content{font-size:12px;color:var(--text2)}
.msg-thinking .md-content code{color:var(--text2)}
.msg-thinking .md-content pre{background:var(--bg2)}.msg-thinking .md-content pre code{color:var(--text2)}
.msg-thinking .md-content strong{color:#a8b5c2}
.msg-tool{font-size:11px;color:#6e7681;font-family:monospace;padding:3px 8px;background:var(--bg1);border-radius:4px;border-left:2px solid var(--border);margin-top:2px}
.search-results{position:absolute;top:40px;left:0;right:0;background:var(--bg1);border:1px solid var(--border);border-radius:8px;max-height:400px;overflow-y:auto;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.3);display:none}
.search-results.show{display:block}
.search-result-item{padding:8px 12px;border-bottom:1px solid var(--border2);cursor:pointer;font-size:12px}
.search-result-item:hover{background:var(--bg3)}
.sr-title{font-weight:500;color:var(--text);margin-bottom:2px}
.sr-dir{color:#79c0ff;font-family:monospace;font-size:10px}
.sr-excerpt{color:var(--text2);font-size:11px;margin-top:2px}
.sr-excerpt mark{background:#3d2b00;color:var(--orange);padding:0 2px;border-radius:2px}
.sr-time{color:var(--text3);font-size:10px;margin-top:2px}
.search-no-result{padding:16px;text-align:center;color:var(--text2);font-size:13px}
.msg-steps{margin-top:6px;border-left:2px solid var(--border);padding-left:8px}
.msg-steps-label{font-size:11px;color:var(--text2);cursor:pointer;user-select:none;display:flex;align-items:center;gap:4px;padding:2px 0}
.msg-steps-label:hover{color:var(--text)}
.msg-steps-label .arrow{transition:transform .15s;display:inline-block;font-size:10px}
.msg-steps-label .arrow.open{transform:rotate(90deg)}
.msg-steps-content{display:none;padding:6px 0}
.msg-steps-content.show{display:block}
.steps-section{margin-bottom:8px}
.steps-section-title{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}

/* themes */
body.light{--bg0:#ffffff;--bg1:#f6f8fa;--bg2:#ffffff;--bg3:#eaeef2;--border:#d0d7de;--border2:#e1e4e8;--text:#1f2328;--text2:#656d76;--text3:#8b949e;--blue:#0969da;--green:#1a7f37;--orange:#bc4c00;--purple:#8250df}
body.light .sess-title{color:#1f2328}
body.light .proj-name{color:#1f2328}
body.light .right-header h2{color:#1f2328}
body.light .md-content{color:#1f2328}
body.light .md-content strong{color:#1f2328}
body.light .msg-text.md{color:#1f2328}

body.midnight{--bg0:#0d1017;--bg1:#161b22;--bg2:#010409;--bg3:#1c2128;--border:#30363d;--border2:#21262d;--text:#e6edf3;--text2:#7d8590;--text3:#484f58;--blue:#58a6ff;--green:#3fb950;--orange:#d29922;--purple:#bc8cff}
</style>
</head>
<body>

<div class="topbar">
  <button class="topbar-menu-btn" onclick="toggleSidebar()" title="Toggle sidebar">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
  </button>
  <h1>MiMoCode Viewer</h1>
  <div class="search-box">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
    <input type="text" id="searchInput" placeholder="Search messages..." oninput="debounce(doSearch,400)()">
    <button class="search-clear" id="searchClear" onclick="clearSearch()" style="display:none">&times;</button>
  </div>
  <div class="filters">
    <label>Days:</label>
    <select id="daysFilter" onchange="loadTree()"><option value="7">7</option><option value="30">30</option><option value="90" selected>90</option><option value="365">365</option></select>
    <span id="treeStats" style="color:var(--text2);font-size:11px"></span>
  </div>
  <div class="theme-switcher">
    <button onclick="setTheme('dark')" class="theme-btn active" data-theme="dark" title="Dark">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/></svg>
    </button>
    <button onclick="setTheme('light')" class="theme-btn" data-theme="light" title="Light">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1z"/></svg>
    </button>
    <button onclick="setTheme('midnight')" class="theme-btn" data-theme="midnight" title="Midnight">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12.1 22c-5.5 0-10-4.5-10-10 0-4.8 3.4-8.8 8.1-9.8.4-.1.8.1 1 .5.2.4.1.8-.2 1.1-.5.5-.8 1.2-.8 2 0 1.7 1.3 3 3 3 .6 0 1.2-.2 1.7-.5.4-.2.8-.1 1.1.2.3.3.4.7.2 1.1-.8 2.2-2.7 3.8-4.8 4.3-.3.1-.5.3-.5.6 0 .2 0 .3.1.5.5 3.4 3.5 6 7.1 6 4 0 7.2-3.2 7.2-7.2 0-3.8-2.9-6.9-6.6-7.2-.4 0-.7-.3-.7-.7s.3-.7.7-.7c4.6.3 8.2 4 8.2 8.6 0 4.8-3.9 8.7-8.7 8.7z"/></svg>
    </button>
  </div>
</div>
<div class="search-results" id="searchResults"></div>

<div class="main">
  <div class="left" id="leftPanel">
    <div class="left-header">
      <span>Projects / Sessions</span>
    </div>
    <div class="tree" id="treeContainer"><div class="loading">Loading...</div></div>
  </div>
  <div class="right" id="rightPanel">
    <div class="right-empty">
      <div>Select a session from the tree</div>
      <div class="hint">Project ▸ Session ▸ Messages</div>
    </div>
  </div>
</div>

<script>
let activeSessionId=null, showThinking=false, treeData=[], sidebarOpen=true;

function debounce(fn,ms){let t;return function(...a){clearTimeout(t);t=setTimeout(()=>fn.apply(this,a),ms)}}

function fmtTime(ms){if(!ms)return'-';return new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
function fmtTimeFull(ms){if(!ms)return'-';return new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}
function trunc(s,n){return s&&s.length>n?s.slice(0,n)+'...':s||''}
function escHtml(s){return s?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):''}

function setTheme(name){
  document.body.className=name==='dark'?'':name;
  localStorage.setItem('theme',name);
  document.querySelectorAll('.theme-btn').forEach(b=>b.classList.toggle('active',b.dataset.theme===name));
}
(function(){const t=localStorage.getItem('theme')||'dark';setTheme(t)})();

function toggleSidebar(){
  sidebarOpen=!sidebarOpen;
  document.getElementById('leftPanel').classList.toggle('collapsed',!sidebarOpen);
}

async function loadTree(){
  const days=document.getElementById('daysFilter').value;
  const res=await fetch('/api/tree?days='+days);
  treeData=await res.json();
  const totalSessions=treeData.reduce((a,d)=>a+d.sessions.length,0);
  const totalTasks=treeData.reduce((a,d)=>a+d.sessions.reduce((b,s)=>b+s.tasks.length,0),0);
  document.getElementById('treeStats').textContent=treeData.length+' directories · '+totalSessions+' sessions · '+totalTasks+' tasks';
  renderTree();
}

function renderTree(){
  let html='';
  for(const d of treeData){
    const did='dir-'+d.dir.replace(/[^a-zA-Z0-9]/g,'-').slice(0,30);
    html+='<div class="proj" id="'+did+'">';
    html+='<div class="proj-head" onclick="toggleProj('+"'"+did+"'"+')">';
    html+='<span class="proj-arrow open">&#9654;</span>';
    html+='<span class="proj-icon">&#128193;</span>';
    html+='<span class="proj-name" title="'+escHtml(d.dir)+'">'+escHtml(trunc(d.dir,40))+'</span>';
    html+='<span class="proj-count">'+d.sessions.length+'</span></div>';
    html+='<div class="proj-sessions open">';
    for(const s of d.sessions){
      const isActive=s.id===activeSessionId;
      const hasTasks=s.tasks&&s.tasks.length>0;
      html+='<div class="sess" id="sess-'+s.id+'">';
      html+='<div class="sess-head'+(isActive?' active':'')+'" onclick="selectSession('+"'"+s.id+"'"+','+"'"+did+"'"+')">';
      html+='<span class="sess-title">'+escHtml(trunc(s.title||'(no title)',48))+'</span>';
      html+='<span class="sess-meta">'+fmtTime(s.time_updated)+' · '+s.msg_count+'m</span></div>';
      html+='<div class="sess-detail'+(isActive?' open':'')+'" id="detail-'+s.id+'">';
      html+='<div class="sd-row"><span class="sd-label">Created</span><span class="sd-val">'+fmtTimeFull(s.time_created)+'</span></div>';
      html+='<div class="sd-row"><span class="sd-label">Updated</span><span class="sd-val">'+fmtTimeFull(s.time_updated)+'</span></div>';
      html+='<div class="sd-row"><span class="sd-label">Messages</span><span class="sd-val">'+s.msg_count+'</span></div>';
      html+='</div>';
      if(hasTasks){
        html+='<div class="sess-tasks'+(isActive?' open':'')+'">';
        for(const t of s.tasks){
          const tc=t.status==='done'?'badge-done':t.status==='open'?'badge-open':'badge-progress';
          html+='<div class="task-node"><span class="badge '+tc+'">'+t.status+'</span>'+t.id+': '+escHtml(trunc(t.summary,50))+'</div>';
        }
        html+='</div>';
      }
      html+='</div>';
    }
    html+='</div></div>';
  }
  document.getElementById('treeContainer').innerHTML=html||'<div class="loading">No data</div>';
}

function toggleProj(did){
  const el=document.getElementById(did);
  if(!el)return;
  el.querySelector('.proj-sessions').classList.toggle('open');
  el.querySelector('.proj-arrow').classList.toggle('open');
}

async function selectSession(id,projId){
  // If clicking the same session, toggle its detail panel
  if(activeSessionId===id){
    const detail=document.getElementById('detail-'+id);
    const sess=document.getElementById('sess-'+id);
    if(detail)detail.classList.toggle('open');
    if(sess){
      const tasks=sess.querySelector('.sess-tasks');
      if(tasks)tasks.classList.toggle('open');
    }
    return;
  }

  // Close previous session's detail
  if(activeSessionId){
    const prevDetail=document.getElementById('detail-'+activeSessionId);
    const prevSess=document.getElementById('sess-'+activeSessionId);
    if(prevDetail)prevDetail.classList.remove('open');
    if(prevSess){
      prevSess.querySelector('.sess-head')?.classList.remove('active');
      const prevTasks=prevSess.querySelector('.sess-tasks');
      if(prevTasks)prevTasks.classList.remove('open');
    }
  }

  activeSessionId=id;
  // Open new session's detail
  const detail=document.getElementById('detail-'+id);
  const sess=document.getElementById('sess-'+id);
  if(detail)detail.classList.add('open');
  if(sess){
    sess.querySelector('.sess-head')?.classList.add('active');
    const tasks=sess.querySelector('.sess-tasks');
    if(tasks)tasks.classList.add('open');
  }

  const panel=document.getElementById('rightPanel');
  panel.innerHTML='<div class="loading">Loading...</div>';
  const res=await fetch('/api/session?id='+encodeURIComponent(id));
  const data=await res.json();
  if(data.error){panel.innerHTML='<div class="right-empty">Error: '+data.error+'</div>';return}
  if(activeSessionId!==id)return;

  const hasThinking=data.messages.some(m=>m.thinking);
  let html='<div class="right-header"><h2>'+escHtml(data.session.title||'(no title)');
  if(hasThinking) html+='<button class="thinking-toggle'+(showThinking?' on':'')+'" id="thinkingBtn" onclick="toggleAllThinking()">Show Thinking</button>';
  html+='</h2>';
  html+='<div class="right-meta">';
  html+='<div class="item"><span class="label">Directory</span><span class="value dir">'+escHtml(data.session.directory)+'</span></div>';
  html+='<div class="item"><span class="label">Created</span><span class="value">'+fmtTimeFull(data.session.time_created)+'</span></div>';
  html+='<div class="item"><span class="label">Updated</span><span class="value">'+fmtTimeFull(data.session.time_updated)+'</span></div>';
  html+='</div></div>';

  if(data.tasks.length>0){
    html+='<div class="right-tasks-bar">';
    for(const t of data.tasks){
      const tc=t.status==='done'?'badge-done':t.status==='open'?'badge-open':'badge-progress';
      html+='<span class="task-node" style="padding:0"><span class="badge '+tc+'">'+t.status+'</span>'+t.id+': '+escHtml(trunc(t.summary,60))+'</span>';
    }
    html+='</div>';
  }

  // Group messages into conversation turns
  html+='<div class="right-messages" id="msgList">';
  const msgs=data.messages;
  let i=0;
  while(i<msgs.length){
    const m=msgs[i];
    if(!m.text&&!m.thinking&&!m.toolSummary){i++;continue;}

    if(m.role==='user'){
      // User message - always show directly
      html+='<div class="msg user-msg">';
      html+='<div class="msg-role user"><span class="role-icon">&#128100;</span>USER<span class="msg-time">'+fmtTimeFull(m.time_created)+'</span></div>';
      html+='<div class="msg-text md">'+marked.parse(m.text)+'</div>';
      html+='</div>';
      i++;
    } else {
      // Assistant turn - collect consecutive assistant messages
      const turn={textParts:[],thinkingParts:[],toolParts:[],time:m.time_created};
      while(i<msgs.length&&msgs[i].role==='assistant'){
        const a=msgs[i];
        if(a.text) turn.textParts.push(a.text);
        if(a.thinking) turn.thinkingParts.push(a.thinking);
        if(a.toolSummary) turn.toolParts.push(a.toolSummary);
        i++;
      }
      // Render assistant turn
      const finalText=turn.textParts.join(String.fromCharCode(10,10));
      const allThinking=turn.thinkingParts.join(String.fromCharCode(10,10));
      const allTools=turn.toolParts.join(String.fromCharCode(10));
      const hasSteps=turn.toolParts.length>0||turn.thinkingParts.length>0;
      html+='<div class="msg assistant-msg">';
      html+='<div class="msg-role assistant"><span class="role-icon">&#129302;</span>ASSISTANT<span class="msg-time">'+fmtTimeFull(turn.time)+'</span></div>';
      if(finalText){
        html+='<div class="msg-text md">'+marked.parse(finalText)+'</div>';
      }
      if(hasSteps){
        const tid='turn-'+Math.random().toString(36).slice(2,8);
        const vis=showThinking?'show':'';
        html+='<div class="msg-steps">';
        html+='<div class="msg-steps-label" onclick="toggleSteps('+"'"+tid+"'"+')"><span class="arrow'+(vis?' open':'')+'">&#9654;</span> '+turn.toolParts.length+' tool calls, '+turn.thinkingParts.length+' reasoning steps</div>';
        html+='<div class="msg-steps-content'+(vis?' show':'')+'" id="'+tid+'">';
        // Render tools
        if(allTools){
          html+='<div class="steps-section"><div class="steps-section-title">Tool Calls</div>';
          html+='<div class="msg-tool">'+escHtml(allTools)+'</div></div>';
        }
        // Render thinking
        if(allThinking){
          html+='<div class="steps-section"><div class="steps-section-title">Reasoning</div>';
          html+='<div class="msg-thinking-content show" style="max-height:300px">'+marked.parse(allThinking)+'</div></div>';
        }
        html+='</div></div>';
      }
      html+='</div>';
    }
  }
  html+='</div>';
  panel.innerHTML=html;
}

function toggleOneThinking(tid,label){
  const el=document.getElementById(tid);if(!el)return;
  el.classList.toggle('show');
  const arrow=label.querySelector('.arrow');if(arrow)arrow.classList.toggle('open');
}

function toggleSteps(tid){
  const el=document.getElementById(tid);if(!el)return;
  el.classList.toggle('show');
  const arrow=el.previousElementSibling?.querySelector('.arrow');
  if(arrow)arrow.classList.toggle('open');
}
function toggleAllThinking(){
  showThinking=!showThinking;
  document.querySelectorAll('.msg-thinking-content').forEach(el=>el.classList.toggle('show',showThinking));
  document.querySelectorAll('.msg-thinking-label .arrow').forEach(a=>a.classList.toggle('open',showThinking));
  const btn=document.getElementById('thinkingBtn');if(btn)btn.classList.toggle('on',showThinking);
}
function zoomImg(src){
  let ov=document.getElementById('imgZoom');
  if(!ov){
    ov=document.createElement('div');
    ov.id='imgZoom';
    ov.className='img-zoom-overlay';
    ov.onclick=()=>ov.classList.remove('show');
    document.body.appendChild(ov);
  }
  ov.innerHTML='';
  const big=document.createElement('img');
  big.src=src;
  ov.appendChild(big);
  ov.classList.add('show');
}
// 点击消息中的图片则放大查看
document.addEventListener('click',(e)=>{
  const t=e.target;
  if(t&&t.tagName==='IMG'&&t.classList.contains('msg-img')){
    zoomImg(t.src);
  }
});

async function doSearch(){
  const q=document.getElementById('searchInput').value.trim();
  const el=document.getElementById('searchResults');
  const clearBtn=document.getElementById('searchClear');
  if(!q){el.classList.remove('show');clearBtn.style.display='none';return}
  clearBtn.style.display='block';
  const res=await fetch('/api/search?q='+encodeURIComponent(q)+'&limit=20');
  const results=await res.json();
  if(results.length===0){
    el.innerHTML='<div class="search-no-result">No results found for "'+escHtml(q)+'"</div>';
  } else {
    let html='';
    for(const r of results){
      let excerpt='';
      if(r.text_part){
        try{const t=JSON.parse(r.text_part);if(t.text){const idx=t.text.toLowerCase().indexOf(q.toLowerCase());if(idx>=0){const start=Math.max(0,idx-40);const end=Math.min(t.text.length,idx+q.length+60);let s=t.text.slice(start,end);if(start>0)s='...'+s;if(end<t.text.length)s+='...';excerpt=s;}}}catch(e){}
      }
      html+='<div class="search-result-item" onclick="jumpToSession('+"'"+r.session_id+"'"+')">';
      html+='<div class="sr-title">'+escHtml(r.session_title||'(no title)')+'</div>';
      html+='<div class="sr-dir">'+escHtml(r.session_dir||'')+'</div>';
      if(excerpt) html+='<div class="sr-excerpt">'+excerpt+'</div>';
      html+='<div class="sr-time">'+fmtTimeFull(r.time_created)+'</div>';
      html+='</div>';
    }
    el.innerHTML=html;
  }
  el.classList.add('show');
}

function clearSearch(){
  document.getElementById('searchInput').value='';
  document.getElementById('searchResults').classList.remove('show');
  document.getElementById('searchClear').style.display='none';
}

function jumpToSession(sid){
  clearSearch();
  selectSession(sid,'');
}

// Close search on click outside
document.addEventListener('click',function(e){
  if(!e.target.closest('.search-box')&&!e.target.closest('.search-results')){
    document.getElementById('searchResults').classList.remove('show');
  }
});

loadTree();
</script>
</body>
</html>`;
