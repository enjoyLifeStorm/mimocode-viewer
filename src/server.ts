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

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // --- API ---
    if (url.pathname === "/api/sessions") {
      const db = getDb();
      const days = parseInt(url.searchParams.get("days") || "30");
      const dir = url.searchParams.get("dir") || "";
      let query = `
        SELECT s.id, s.title, s.directory, s.project_id, s.time_created, s.time_updated,
               (SELECT COUNT(*) FROM task t WHERE t.session_id = s.id) as task_count,
               (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) as msg_count
        FROM session s WHERE s.parent_id IS NULL AND s.time_updated > ?`;
      const params: any[] = [Date.now() - days * 86400000];
      if (dir) { query += ` AND s.directory LIKE ?`; params.push(`%${dir}%`); }
      query += ` ORDER BY s.time_updated DESC`;
      const rows = db.query(query).all(...params);
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
        SELECT m.id, m.data as msg_data, m.time_created,
               (SELECT GROUP_CONCAT(p.data, ' ') FROM part p WHERE p.message_id = m.id) as content
        FROM message m WHERE m.session_id = ? ORDER BY m.time_created DESC LIMIT 200
      `).all(sid);
      // Parse roles from JSON, separate text, thinking, and tool calls
      const parsed = messages.map((m: any) => {
        let role = "unknown";
        try { role = JSON.parse(m.msg_data).role || "unknown"; } catch {}
        let text = "";
        let thinking = "";
        let toolSummary = "";
        try {
          const raw = m.content || "";
          const chunks: string[] = [];
          let depth = 0, start = -1;
          for (let i = 0; i < raw.length; i++) {
            if (raw[i] === '{') {
              if (depth === 0) start = i;
              depth++;
            } else if (raw[i] === '}') {
              depth--;
              if (depth === 0 && start >= 0) {
                chunks.push(raw.slice(start, i + 1));
                start = -1;
              }
            } else if (raw[i] === '"') {
              i++;
              while (i < raw.length && raw[i] !== '"') {
                if (raw[i] === '\\') i++;
                i++;
              }
            }
          }
          const tools: string[] = [];
          for (const c of chunks) {
            try {
              const obj = JSON.parse(c);
              if (obj.type === "text" && obj.text) {
                text += (text ? "\n" : "") + obj.text;
              }
              if (obj.type === "reasoning" && obj.text) {
                thinking += (thinking ? "\n" : "") + obj.text;
              }
              if (obj.type === "tool" && obj.tool) {
                const toolName = obj.tool;
                let detail = "";
                if (obj.state?.input) {
                  const inp = obj.state.input;
                  if (inp.file_path) detail = inp.file_path.split(/[/\\]/).pop() || "";
                  else if (inp.command) detail = inp.command.slice(0, 60);
                  else if (inp.pattern) detail = inp.pattern.slice(0, 40);
                  else if (inp.url) detail = inp.url.slice(0, 50);
                  else if (inp.query) detail = inp.query.slice(0, 40);
                }
                tools.push(detail ? `${toolName}(${detail})` : toolName);
              }
            } catch {}
          }
          if (tools.length > 0) {
            toolSummary = tools.join(", ");
          }
        } catch {}
        // For tool-only messages, create a brief summary instead of "(no text)"
        let displayText = text;
        if (!text && toolSummary) {
          displayText = `[${toolSummary}]`;
        } else if (!text) {
          displayText = "";
        }
        return { role, time_created: m.time_created, text: displayText, thinking, toolSummary };
      }).reverse();
      db.close();
      return json({ session, tasks, messages: parsed });
    }

    if (url.pathname === "/api/projects") {
      const db = getDb();
      const rows = db.query("SELECT * FROM project").all();
      db.close();
      return json(rows);
    }

    // Tree API: directory → sessions → tasks
    if (url.pathname === "/api/tree") {
      const db = getDb();
      const days = parseInt(url.searchParams.get("days") || "90");
      const cutoff = Date.now() - days * 86400000;
      const sessions = db.query(`
        SELECT s.id, s.title, s.directory, s.project_id, s.time_created, s.time_updated,
               (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) as msg_count
        FROM session s WHERE s.parent_id IS NULL AND s.time_updated > ? ORDER BY s.time_updated DESC
      `).all(cutoff) as any[];
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
        .map(([dir, sess]) => ({ dir, sessions: sess }));
      return json(dirs);
    }

    // --- Frontend ---
    if (url.pathname === "/marked.min.js") {
      const file = Bun.file(join(import.meta.dir, "marked.min.js"));
      return new Response(file, { headers: { "Content-Type": "application/javascript" } });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return html(HTML);
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
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0f1117;color:#e1e4e8;height:100vh;display:flex;flex-direction:column;overflow:hidden}
.topbar{background:#161b22;border-bottom:1px solid #30363d;padding:10px 20px;display:flex;align-items:center;gap:16px;flex-shrink:0}
.topbar h1{font-size:18px;font-weight:600;color:#58a6ff;white-space:nowrap}
.topbar .filters{display:flex;gap:8px;align-items:center;margin-left:auto}
.topbar .filters input,.topbar .filters select{background:#0d1117;border:1px solid #30363d;color:#e1e4e8;padding:4px 8px;border-radius:4px;font-size:12px}
.topbar .filters input{width:160px}
.topbar .filters label{color:#8b949e;font-size:12px}
.main{display:flex;flex:1;overflow:hidden}

/* left tree panel */
.left{width:420px;min-width:300px;border-right:1px solid #30363d;display:flex;flex-direction:column;overflow:hidden}
.left-header{padding:8px 12px;border-bottom:1px solid #21262d;color:#8b949e;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;flex-shrink:0}
.tree{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#30363d transparent;padding:4px 0}
/* project node */
.proj{margin-bottom:2px}
.proj-head{display:flex;align-items:center;gap:6px;padding:6px 12px;cursor:pointer;user-select:none;border-radius:4px;margin:0 4px}
.proj-head:hover{background:#161b22}
.proj-arrow{font-size:10px;color:#8b949e;transition:transform .15s;width:12px;text-align:center}
.proj-arrow.open{transform:rotate(90deg)}
.proj-icon{color:#f0883e;font-size:13px}
.proj-name{font-size:13px;font-weight:600;color:#e1e4e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.proj-count{font-size:10px;color:#8b949e;margin-left:auto;white-space:nowrap}
.proj-sessions{display:none;padding-left:16px}
.proj-sessions.open{display:block}
/* session node */
.sess{margin:1px 0}
.sess-head{display:flex;align-items:center;gap:6px;padding:5px 10px;cursor:pointer;border-radius:4px;margin:0 4px;border-left:2px solid transparent}
.sess-head:hover{background:#161b22}
.sess-head.active{background:#1c2333;border-left-color:#58a6ff}
.sess-title{font-size:12px;color:#c9d1d9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.sess-meta{font-size:10px;color:#484f58;white-space:nowrap;flex-shrink:0}
.sess-tasks{padding-left:20px;display:none}
.sess-tasks.open{display:block}
.task-node{display:flex;align-items:center;gap:6px;padding:2px 10px;font-size:11px;color:#8b949e}
.badge{display:inline-block;padding:1px 5px;border-radius:6px;font-size:9px;font-weight:600}
.badge-done{background:#1b4332;color:#40c057}
.badge-open{background:#1a1e2e;color:#58a6ff}
.badge-progress{background:#2d1b00;color:#f0883e}

/* right panel */
.right{flex:1;display:flex;flex-direction:column;overflow:hidden}
.right-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#484f58;font-size:15px;flex-direction:column;gap:8px}
.right-empty .hint{font-size:12px;color:#30363d}
.right-header{padding:12px 20px;border-bottom:1px solid #30363d;background:#161b22;flex-shrink:0}
.right-header h2{font-size:15px;font-weight:600;color:#e1e4e8;margin-bottom:6px;display:flex;align-items:center;gap:8px}
.right-meta{display:flex;gap:16px;flex-wrap:wrap}
.right-meta .item{display:flex;flex-direction:column;gap:1px}
.right-meta .label{font-size:10px;color:#8b949e;text-transform:uppercase}
.right-meta .value{font-size:12px;color:#e1e4e8}
.right-meta .dir{color:#79c0ff;font-family:monospace;font-size:11px}
.right-tasks-bar{padding:6px 20px;border-bottom:1px solid #21262d;background:#0d1117;flex-shrink:0;display:flex;gap:8px;flex-wrap:wrap}
.right-messages{flex:1;overflow-y:auto;padding:12px 20px;scrollbar-width:thin;scrollbar-color:#30363d transparent}
.msg{margin-bottom:12px;border-bottom:1px solid #161b22;padding-bottom:8px}
.msg-role{font-size:10px;font-weight:600;text-transform:uppercase;margin-bottom:3px;display:flex;align-items:center;gap:6px}
.msg-role.user{color:#3fb950}
.msg-role.assistant{color:#58a6ff}
.msg-role.unknown{color:#8b949e}
.msg-role .msg-time{margin-left:auto;font-weight:400}
.msg-thinking{margin-top:4px;border-left:3px solid #30363d;padding-left:8px}
.msg-thinking-label{font-size:10px;color:#8b949e;cursor:pointer;user-select:none;margin-bottom:2px;display:flex;align-items:center;gap:4px}
.msg-thinking-label:hover{color:#e1e4e8}
.msg-thinking-label .arrow{transition:transform .15s;display:inline-block}
.msg-thinking-label .arrow.open{transform:rotate(90deg)}
.msg-thinking-content{display:none;font-size:12px;color:#8b949e;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;padding:4px 6px;background:#0d1117;border-radius:4px;margin-top:4px}
.msg-thinking-content.show{display:block}
.thinking-toggle{background:#0d1117;border:1px solid #30363d;color:#8b949e;padding:3px 8px;border-radius:4px;font-size:11px;cursor:pointer}
.thinking-toggle:hover{background:#161b22;color:#e1e4e8}
.thinking-toggle.on{border-color:#58a6ff;color:#58a6ff}
.loading{display:flex;align-items:center;justify-content:center;height:100%;color:#8b949e}

/* markdown */
.md-content{font-size:13px;color:#c9d1d9;line-height:1.6;word-break:break-word}
.md-content p{margin:0 0 8px 0}.md-content p:last-child{margin-bottom:0}
.md-content ul,.md-content ol{margin:4px 0 8px 20px}.md-content li{margin:2px 0}
.md-content code{background:#21262d;padding:1px 5px;border-radius:3px;font-family:'SF Mono',Consolas,monospace;font-size:12px;color:#f0883e}
.md-content pre{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px 12px;overflow-x:auto;margin:6px 0}
.md-content pre code{background:transparent;padding:0;color:#c9d1d9;font-size:12px}
.md-content strong{color:#e1e4e8;font-weight:600}.md-content em{color:#d2a8ff}
.md-content a{color:#58a6ff;text-decoration:none}.md-content a:hover{text-decoration:underline}
.md-content blockquote{border-left:3px solid #30363d;padding-left:10px;color:#8b949e;margin:6px 0}
.md-content h1,.md-content h2,.md-content h3,.md-content h4{color:#e1e4e8;margin:10px 0 6px 0}
.md-content h1{font-size:16px}.md-content h2{font-size:15px}.md-content h3{font-size:14px}.md-content h4{font-size:13px}
.md-content table{border-collapse:collapse;margin:6px 0;font-size:12px}
.md-content th,.md-content td{border:1px solid #30363d;padding:4px 8px}
.md-content th{background:#161b22;color:#8b949e}
.md-content hr{border:none;border-top:1px solid #30363d;margin:8px 0}
.msg-text.md{padding:6px 8px;border-radius:4px;max-height:300px;overflow-y:auto;cursor:default}
.msg-text.md.expanded{max-height:none}
.msg-thinking .md-content{font-size:12px;color:#8b949e}
.msg-thinking .md-content code{color:#8b949e}
.msg-thinking .md-content pre{background:#0a0d12}.msg-thinking .md-content pre code{color:#8b949e}
.msg-thinking .md-content strong{color:#a8b5c2}
.msg-tool{font-size:11px;color:#6e7681;font-family:monospace;padding:3px 8px;background:#161b22;border-radius:4px;border-left:2px solid #30363d;margin-top:2px}
</style>
</head>
<body>

<div class="topbar">
  <h1>MiMoCode Viewer</h1>
  <div class="filters">
    <label>Days:</label>
    <select id="daysFilter" onchange="loadTree()"><option value="7">7</option><option value="30">30</option><option value="90" selected>90</option><option value="365">365</option></select>
    <span id="treeStats" style="color:#8b949e;font-size:11px"></span>
  </div>
</div>

<div class="main">
  <div class="left">
    <div class="left-header">Projects / Sessions</div>
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
let activeSessionId=null, showThinking=false, treeData=[];

function fmtTime(ms){if(!ms)return'-';return new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
function fmtTimeFull(ms){if(!ms)return'-';return new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}
function trunc(s,n){return s&&s.length>n?s.slice(0,n)+'...':s||''}
function escHtml(s){return s?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):''}

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
    html+='<div class="proj-head" onclick="toggleProj(\\''+did+'\\')">';
    html+='<span class="proj-arrow open">&#9654;</span>';
    html+='<span class="proj-icon">&#128193;</span>';
    html+='<span class="proj-name" title="'+escHtml(d.dir)+'">'+escHtml(trunc(d.dir,40))+'</span>';
    html+='<span class="proj-count">'+d.sessions.length+'</span></div>';
    html+='<div class="proj-sessions open">';
    for(const s of d.sessions){
      const isActive=s.id===activeSessionId;
      const hasTasks=s.tasks&&s.tasks.length>0;
      html+='<div class="sess">';
      html+='<div class="sess-head'+(isActive?' active':'')+'" onclick="selectSession(\\''+s.id+'\\',\\''+did+'\\')">';
      html+='<span class="sess-title">'+escHtml(trunc(s.title||'(no title)',48))+'</span>';
      html+='<span class="sess-meta">'+fmtTime(s.time_updated)+' · '+s.msg_count+'m</span></div>';
      if(hasTasks){
        html+='<div class="sess-tasks">';
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
  activeSessionId=id;
  document.querySelectorAll('.sess-head').forEach(h=>h.classList.remove('active'));
  // Find and activate the correct sess-head
  const proj=document.getElementById(projId);
  if(proj){
    const heads=proj.querySelectorAll('.sess-head');
    for(const h of heads){
      if(h.getAttribute('onclick')&&h.getAttribute('onclick').includes(id)){
        h.classList.add('active');
        // Toggle task visibility
        const sess=h.parentElement;
        const tasks=sess.querySelector('.sess-tasks');
        if(tasks)tasks.classList.toggle('open');
        break;
      }
    }
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

  html+='<div class="right-messages" id="msgList">';
  for(const m of data.messages){
    if(!m.text&&!m.thinking) continue;
    html+='<div class="msg">';
    html+='<div class="msg-role '+m.role+'">'+m.role+'<span class="msg-time">'+fmtTimeFull(m.time_created)+'</span></div>';
    if(m.text){
      html+='<div class="msg-text md" onclick="this.classList.toggle(\\'expanded\\')">'+marked.parse(m.text)+'</div>';
    } else if(m.toolSummary){
      html+='<div class="msg-tool">[tool calls: '+escHtml(m.toolSummary)+']</div>';
    }
    if(m.thinking){
      const tid='think-'+Math.random().toString(36).slice(2,8);
      const vis=showThinking?'show':'';
      html+='<div class="msg-thinking">';
      html+='<div class="msg-thinking-label" onclick="toggleOneThinking(\\''+tid+'\\',this)"><span class="arrow'+(vis?' open':'')+'">&#9654;</span> thinking ('+m.thinking.length+' chars)</div>';
      html+='<div class="msg-thinking-content'+(vis?' show':'')+'" id="'+tid+'">'+marked.parse(m.thinking)+'</div></div>';
    }
    html+='</div>';
  }
  html+='</div>';
  panel.innerHTML=html;
}

function toggleOneThinking(tid,label){
  const el=document.getElementById(tid);if(!el)return;
  el.classList.toggle('show');
  const arrow=label.querySelector('.arrow');if(arrow)arrow.classList.toggle('open');
}
function toggleAllThinking(){
  showThinking=!showThinking;
  document.querySelectorAll('.msg-thinking-content').forEach(el=>el.classList.toggle('show',showThinking));
  document.querySelectorAll('.msg-thinking-label .arrow').forEach(a=>a.classList.toggle('open',showThinking));
  const btn=document.getElementById('thinkingBtn');if(btn)btn.classList.toggle('on',showThinking);
}

loadTree();
</script>
</body>
</html>`;
