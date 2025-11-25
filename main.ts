/// <reference lib="deno.ns" />

const kv = await Deno.openKv();

// ==========================================
// 1. HELPER FUNCTIONS
// ==========================================
async function hashPassword(p: string, s: string) {
  const data = new TextEncoder().encode(p + s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function generateId() { return crypto.randomUUID(); }
function escapeHtml(unsafe: string) {
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// --- FOOTBALL DATA FETCHING LOGIC ---
async function getFootballData() {
    try {
        const getVNDate = (offset: number) => {
            const d = new Date();
            d.setDate(d.getDate() + offset);
            // Asia/Ho_Chi_Minh is UTC+7
            // We simulate this by adding offset to UTC time if needed, 
            // but Intl.DateTimeFormat is safest on Deno Deploy
            return new Intl.DateTimeFormat("en-CA", {
                timeZone: "Asia/Ho_Chi_Minh",
                year: "numeric", month: "2-digit", day: "2-digit"
            }).format(d).replace(/-/g, "");
        };

        const dates = [getVNDate(-1), getVNDate(0), getVNDate(1)];
        let allMatches: any[] = [];

        for (const date of dates) {
            const url = `https://json.vnres.co/match/matches_${date}.json`;
            const res = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    "Referer": "https://socolivev.co/"
                }
            });
            
            if (!res.ok) continue;
            const txt = await res.text();
            const match = txt.match(/matches_\d+\((.*)\)/);
            if (!match) continue;

            let json;
            try { json = JSON.parse(match[1]); } catch { continue; }
            if (json.code !== 200 || !json.data) continue;

            const now = Date.now();

            for (const it of json.data) {
                if (it.sportType !== 1) continue; // Football Only

                const mt = it.matchTime; 
                const duration = 3 * 60 * 60 * 1000; // 3 Hours
                let status = "upcoming";
                
                if (now >= mt && now <= mt + duration) status = "live";
                else if (now > mt + duration) status = "finished";

                const servers = [];
                if (status === "live" && it.anchors) {
                    for (const anchor of it.anchors) {
                        try {
                            const roomRes = await fetch(`https://json.vnres.co/room/${anchor.anchor.roomNum}/detail.json`, {
                                headers: { "Referer": "https://socolivev.co/" }
                            });
                            const roomTxt = await roomRes.text();
                            const roomMatch = roomTxt.match(/detail\((.*)\)/);
                            if(roomMatch) {
                                const roomJson = JSON.parse(roomMatch[1]);
                                if(roomJson.data?.stream) {
                                    const s = roomJson.data.stream;
                                    if(s.m3u8) servers.push({ name: "SD", url: s.m3u8 });
                                    if(s.hdM3u8) servers.push({ name: "HD", url: s.hdM3u8 });
                                }
                            }
                        } catch {}
                    }
                }

                // MM Time (UTC+6:30)
                const matchDate = new Date(mt);
                const mmTime = new Date(matchDate.getTime() + (6.5 * 60 * 60 * 1000));
                const timeStr = mmTime.getUTCHours().toString().padStart(2,'0') + ":" + mmTime.getUTCMinutes().toString().padStart(2,'0') + (mmTime.getUTCHours() >= 12 ? " PM" : " AM");

                allMatches.push({
                    league: it.leagueName || it.subCateName,
                    home: it.homeName || it.hostName,
                    away: it.awayName || it.guestName,
                    score: (it.homeScore !== undefined) ? `${it.homeScore} - ${it.awayScore}` : "VS",
                    time: timeStr,
                    raw_time: mt,
                    status: status,
                    servers: servers,
                    home_icon: it.homeIcon || it.hostIcon,
                    away_icon: it.awayIcon || it.guestIcon
                });
            }
        }
        return allMatches.sort((a, b) => (a.status === 'live' ? -1 : 1));
    } catch (e) { return []; }
}

// ==========================================
// 2. SYSTEM INIT
// ==========================================
const adminCheck = await kv.get(["users", "admin"]);
if (!adminCheck.value) {
    const s = generateId();
    const h = await hashPassword("admin123", s);
    await kv.set(["users", "admin"], { 
        passwordHash: h, salt: s, balance: 1000000, 
        joined: new Date().toISOString(), 
        avatar: "https://img.icons8.com/color/96/admin-settings-male.png" 
    });
}

Deno.cron("Save History", "*/2 * * * *", async () => {
  try {
    const res = await fetch("https://api.thaistock2d.com/live");
    const data = await res.json();
    
    // Server Date (UTC+6:30)
    const now = new Date();
    const mmDate = new Date(now.getTime() + (6.5 * 60 * 60 * 1000));
    const dateKey = mmDate.getUTCFullYear() + "-" + String(mmDate.getUTCMonth() + 1).padStart(2, '0') + "-" + String(mmDate.getUTCDate()).padStart(2, '0');
    
    if (!data.live || data.live.date !== dateKey) return;
    if (mmDate.getUTCDay() === 0 || mmDate.getUTCDay() === 6) return; 

    const curHour = mmDate.getUTCHours();
    let m = "--", e = "--";

    if (data.result) {
        if (data.result[1] && data.result[1].twod) m = data.result[1].twod;
        if (curHour >= 16) {
            const ev = data.result[3] || data.result[2];
            if (ev && ev.twod) e = ev.twod;
        }
    }

    const ex = await kv.get(["history", dateKey]);
    let needSave = false;
    const old = ex.value as any || { morning: "--", evening: "--" };
    let saveM = old.morning; let saveE = old.evening;
    if (m !== "--" && m !== old.morning) { saveM = m; needSave = true; }
    if (old.evening === "00" && curHour < 16) { saveE = "--"; needSave = true; } 
    else if (e !== "--" && e !== old.evening) { saveE = e; needSave = true; }

    if (needSave) await kv.set(["history", dateKey], { morning: saveM, evening: saveE, date: dateKey });
  } catch (e) {}
});

// ==========================================
// 3. MAIN SERVER
// ==========================================
Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);

    // --- ASSETS ---
    if (url.pathname === "/manifest.json") {
        return new Response(JSON.stringify({ name: "VIP 2D", short_name: "VIP 2D", start_url: "/", display: "standalone", background_color: "#0f172a", theme_color: "#0f172a", icons: [{ src: "https://img.icons8.com/color/192/shop.png", sizes: "192x192", type: "image/png" }] }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/sw.js") {
        return new Response(`self.addEventListener('install',e=>e.waitUntil(caches.open('v2d-v1').then(c=>c.addAll(['/','/manifest.json']))));self.addEventListener('fetch',e=>e.respondWith(fetch(e.request).catch(()=>caches.match(e.request))));`, { headers: { "content-type": "application/javascript" } });
    }

    // --- DATE CALC ---
    const now = new Date();
    const mmDate = new Date(now.getTime() + (6.5 * 60 * 60 * 1000));
    const SERVER_TODAY_KEY = mmDate.getUTCFullYear() + "-" + String(mmDate.getUTCMonth() + 1).padStart(2, '0') + "-" + String(mmDate.getUTCDate()).padStart(2, '0');

    // --- TEMPLATES ---
    const commonHead = `
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <link rel="manifest" href="/manifest.json">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    <script src="https://html2canvas.hertzen.com/dist/html2canvas.min.js"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;700&family=Padauk:wght@400;700&family=Roboto+Mono:wght@500&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Padauk', sans-serif; background: #0f172a; color: #e2e8f0; padding-bottom: 80px; }
        .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.05); }
        .gold-bg { background: linear-gradient(to bottom right, #bf953f, #aa771c); color: #000; }
        .input-dark { background: #1e293b; border: 1px solid #334155; color: white; border-radius: 0.5rem; padding: 0.5rem; width: 100%; }
        .loader { border: 3px solid #f3f3f3; border-top: 3px solid #eab308; border-radius: 50%; width: 24px; height: 24px; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .slide-up-anim { animation: slideUpDigit 0.6s cubic-bezier(0.22, 1, 0.36, 1); }
        @keyframes slideUpDigit { 0% { transform: translateY(100%); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
        .blink-live { animation: blinker 1.5s linear infinite; }
        @keyframes blinker { 50% { opacity: 0.3; } }
        .no-scrollbar::-webkit-scrollbar { display: none; }
    </style>
    <script>
        const SERVER_DATE_KEY = "${SERVER_TODAY_KEY}";
        function showLoad() { document.getElementById('loader').classList.remove('hidden'); }
        function hideLoad() { document.getElementById('loader').classList.add('hidden'); }
        function doLogout() { showLoad(); setTimeout(() => window.location.href = '/logout', 800); }
        async function adminSubmit(e) {
            e.preventDefault(); showLoad(); const f = e.target, fd = new FormData(f), u = f.getAttribute('action');
            try { const r = await fetch(u, {method:'POST', body:fd}); const d = await r.json(); hideLoad();
                if(d.status === 'success') location.reload(); else Swal.fire({icon:'error', title:'Failed'});
            } catch(e) { hideLoad(); }
        }
        function startClock() {
            setInterval(() => {
                const now = new Date();
                document.getElementById('live_time').innerText = "Updated at: " + now.toLocaleTimeString('en-US', { hour12: true });
            }, 1000);
        }
        function updateNumberWithAnimation(newVal) {
            let s1 = "-", s2 = "-";
            if (newVal.length === 2) { s1 = newVal[0]; s2 = newVal[1]; }
            const d1 = document.getElementById('d1'); const d2 = document.getElementById('d2');
            if (d1 && d1.innerText !== s1) { d1.classList.remove('slide-up-anim'); void d1.offsetWidth; d1.innerText = s1; d1.classList.add('slide-up-anim'); }
            if (d2 && d2.innerText !== s2) { d2.classList.remove('slide-up-anim'); void d2.offsetWidth; d2.innerText = s2; d2.classList.add('slide-up-anim'); }
        }
    </script>`;
    
    const loaderHTML = `<div id="loader" class="fixed inset-0 bg-black/90 z-[9999] hidden flex items-center justify-center"><div class="loader w-10 h-10"></div></div>`;
    const navHTML = `<div class="fixed bottom-0 w-full glass border-t border-white/10 pb-safe flex justify-around items-center h-16 z-40"><a href="/" class="nav-item text-gray-400 flex flex-col items-center"><i class="fas fa-home text-lg"></i><span class="text-[10px]">ပင်မ</span></a><a href="/history" class="nav-item text-gray-400 flex flex-col items-center"><i class="fas fa-calendar-alt text-lg"></i><span class="text-[10px]">မှတ်တမ်း</span></a><a href="/profile" class="nav-item text-gray-400 flex flex-col items-center"><i class="fas fa-user-circle text-lg"></i><span class="text-[10px]">အကောင့်</span></a></div>`;

    const cookies = req.headers.get("Cookie") || "";
    const userCookie = cookies.split(";").find(c => c.trim().startsWith("user="));
    const currentUser = userCookie ? decodeURIComponent(userCookie.split("=")[1].trim()) : null;
    const isAdmin = currentUser === "admin";

    if (url.pathname === "/logout") {
        return new Response(null, { status: 303, headers: { "Location": "/", "Set-Cookie": "user=; Path=/; Max-Age=0" } });
    }

    // --- AUTH ROUTES ---
    if (req.method === "POST") {
        if (url.pathname === "/register") {
            const form = await req.formData(); const u = form.get("username")?.toString().trim(); const p = form.get("password")?.toString();
            if(u==="admin") return new Response(null, {status:303, headers:{"Location":"/?err=forbidden"}});
            const check = await kv.get(["users", u]);
            if(check.value) return new Response(null, {status:303, headers:{"Location":"/?err=exists"}});
            const s = generateId(); const h = await hashPassword(p, s);
            await kv.set(["users", u], { passwordHash: h, salt: s, balance: 0 });
            return new Response(null, { status: 303, headers: { "Location": "/", "Set-Cookie": `user=${encodeURIComponent(u)}; Path=/; HttpOnly; Max-Age=1296000` } });
        }
        if (url.pathname === "/login") {
            const form = await req.formData(); const u = form.get("username")?.toString().trim(); const p = form.get("password")?.toString();
            const entry = await kv.get(["users", u]); const data = entry.value as any;
            if (data && (data.passwordHash ? (await hashPassword(p, data.salt) === data.passwordHash) : p === data.password)) {
                return new Response(null, { status: 303, headers: { "Location": "/", "Set-Cookie": `user=${encodeURIComponent(u)}; Path=/; HttpOnly; Max-Age=1296000` } });
            }
            return new Response(null, {status:303, headers:{"Location":"/?err=invalid"}});
        }

        // LOGGED IN POST ROUTES
        if (currentUser) {
            const form = await req.formData();
            if(url.pathname === "/update_avatar") {
                const img = form.get("avatar")?.toString();
                const uD = (await kv.get(["users", currentUser])).value as any;
                await kv.set(["users", currentUser], {...uD, avatar:img});
                return new Response(JSON.stringify({status:"ok"}));
            }
            if(url.pathname === "/bet") {
                const nums = (form.get("number")?.toString() || "").split(",");
                const amt = parseInt(form.get("amount")?.toString() || "0");
                const uKey = ["users", currentUser]; 
                const uData = (await kv.get(uKey)).value as any;
                
                if(uData.balance < nums.length * amt) return new Response(JSON.stringify({status:"no_balance"}));
                
                const batchId = Date.now().toString().slice(-6);
                let atomic = kv.atomic().check({key:uKey, versionstamp:(await kv.get(uKey)).versionstamp})
                    .set(uKey, {...uData, balance: uData.balance - (nums.length*amt)});
                
                for(const n of nums) {
                     atomic = atomic.set(["bets", Date.now().toString()+Math.random()], {
                        user: currentUser, number: n.trim(), amount: amt, status: "PENDING",
                        time: new Date().toLocaleTimeString(), date: SERVER_TODAY_KEY, batchId
                     });
                }
                await atomic.commit();
                return new Response(JSON.stringify({status:"success", voucher:{id:batchId, user:currentUser}}));
            }
            // ADMIN POST
            if (isAdmin) {
                if(url.pathname === "/admin/topup") {
                    const u = form.get("username")?.toString().trim(); const a = parseInt(form.get("amount")?.toString() || "0");
                    const res = await kv.get(["users", u]);
                    if(res.value) {
                        await kv.set(["users", u], { ...res.value as any, balance: (res.value as any).balance + a });
                        return new Response(JSON.stringify({status:"success"}));
                    }
                }
                if(url.pathname === "/admin/payout") {
                    const win = form.get("win_number")?.toString();
                    const iter = kv.list({prefix:["bets"]});
                    let winners = [];
                    for await(const e of iter) {
                        const b = e.value as any;
                        if(b.status === "PENDING" && b.number === win) {
                            // Payout logic here (Simplified)
                            const uRes = await kv.get(["users", b.user]);
                            if(uRes.value) await kv.set(["users", b.user], {...uRes.value as any, balance: (uRes.value as any).balance + (b.amount * 80)});
                            await kv.set(e.key, {...b, status:"WIN"});
                            winners.push({user:b.user});
                        } else if (b.status === "PENDING") {
                            await kv.set(e.key, {...b, status:"LOSE"});
                        }
                    }
                    return new Response(JSON.stringify({status:"success", winners}));
                }
                if(url.pathname === "/admin/clear_today_history") {
                     await kv.delete(["history", SERVER_TODAY_KEY]);
                     return new Response(JSON.stringify({status:"success"}));
                }
            }
        }
    }

    // --- LOGIN PAGE ---
    if (!currentUser) {
        return new Response(`<!DOCTYPE html><html><head><title>Login</title>${commonHead}</head><body class="flex items-center justify-center min-h-screen bg-black"><div class="p-6 w-full max-w-sm glass rounded-2xl"><div class="text-center mb-6"><h1 class="text-3xl font-bold text-white">VIP 2D</h1></div><form action="/login" method="POST" class="space-y-4"><input name="username" placeholder="အမည်" class="input-dark" required><input name="password" type="password" placeholder="စကားဝှက်" class="input-dark" required><button class="w-full py-3 rounded-xl gold-bg font-bold text-black">အကောင့်ဝင်မည်</button></form><div class="text-center mt-4"><button onclick="document.getElementById('reg').classList.remove('hidden')" class="text-sm text-gray-400">အကောင့်သစ်ဖွင့်မည်</button></div><form id="reg" action="/register" method="POST" class="hidden space-y-4 mt-4 pt-4 border-t border-gray-700"><input name="username" placeholder="အမည်သစ်" class="input-dark" required><input name="password" type="password" placeholder="စကားဝှက်သစ်" class="input-dark" required><button class="w-full py-3 rounded-xl bg-slate-700 text-white font-bold">အကောင့်ဖွင့်မည်</button></form></div><script>const u=new URLSearchParams(location.search); if(u.get('err')) Swal.fire({icon:'error',title:'မှားယွင်းနေသည်'});</script></body></html>`, { headers: { "Content-Type": "text/html" } });
    }

    // --- API: FOOTBALL ---
    if (url.pathname === "/api/football/matches") {
        const matches = await getFootballData();
        return new Response(JSON.stringify(matches), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // --- UI: FOOTBALL ---
    if (url.pathname === "/football") {
        return new Response(`<!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Football Live</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script><link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet"><link href="https://fonts.googleapis.com/css2?family=Padauk:wght@400;700&display=swap" rel="stylesheet"><style>body{background:#0f172a;color:white;font-family:'Padauk',sans-serif}.back-btn{position:fixed;top:15px;left:15px;z-index:50;background:rgba(0,0,0,0.5);padding:8px 12px;border-radius:50px;backdrop-filter:blur(5px)}.glass{background:rgba(30,41,59,0.8);border:1px solid rgba(255,255,255,0.1)}</style></head><body class="max-w-md mx-auto p-4 pt-16"><a href="/" class="back-btn text-white text-sm"><i class="fas fa-arrow-left"></i> 2D</a><h1 class="text-xl font-bold text-center mb-6 text-green-400 fixed top-0 left-0 w-full bg-[#0f172a]/90 backdrop-blur py-4 z-40">⚽ Football Live</h1><div id="player" class="hidden sticky top-16 z-50 mb-4 bg-black rounded-lg overflow-hidden border border-gray-600 shadow-2xl"><video id="vid" controls class="w-full aspect-video" autoplay></video><button onclick="closeP()" class="w-full bg-red-600 text-white text-xs font-bold py-2">Close</button></div><div id="load" class="text-center py-10 text-gray-400">Loading...</div><div id="list" class="space-y-3"></div><script>async function L(){try{const r=await fetch('/api/football/matches');const d=await r.json();document.getElementById('load').style.display='none';const l=document.getElementById('list');if(d.length===0){l.innerHTML='<div class="text-center text-gray-500">No Matches</div>';return}d.forEach(m=>{const isL=m.status==='live';const st=isL?'<span class="text-red-500 font-bold text-xs">● LIVE</span>':'<span class="text-gray-500 text-xs">'+m.time+'</span>';let b='';if(m.servers.length){m.servers.forEach(s=>{b+=\`<button onclick="play('\${s.url}')" class="bg-blue-600 text-white text-[10px] px-3 py-1 rounded mr-2">\${s.name}</button>\`})}else if(isL){b='<span class="text-xs text-yellow-500">Link...</span>'}l.innerHTML+=\`<div class="glass rounded-xl p-3 shadow-lg"><div class="flex justify-between mb-2"><span class="text-xs text-gray-400 truncate w-2/3">\${m.league}</span>\${st}</div><div class="flex justify-between items-center text-center"><div class="w-1/3"><img src="\${m.home_icon}" class="w-8 h-8 mx-auto bg-white/10 rounded-full p-1"><div class="text-xs truncate">\${m.home}</div></div><div class="w-1/3 text-xl font-bold text-yellow-400">\${m.score}</div><div class="w-1/3"><img src="\${m.away_icon}" class="w-8 h-8 mx-auto bg-white/10 rounded-full p-1"><div class="text-xs truncate">\${m.away}</div></div></div><div class="text-center mt-2 pt-2 border-t border-white/5">\${b}</div></div>\`})}catch{}}function play(u){document.getElementById('player').classList.remove('hidden');const v=document.getElementById('vid');if(Hls.isSupported()){const h=new Hls();h.loadSource(u);h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,()=>v.play())}else if(v.canPlayType('application/vnd.apple.mpegurl')){v.src=u;v.play()}window.scrollTo({top:0,behavior:'smooth'})}function closeP(){document.getElementById('vid').pause();document.getElementById('player').classList.add('hidden')}L()</script></body></html>`, { headers: { "Content-Type": "text/html" } });
    }

    // --- UI: 2D HOME ---
    if (url.pathname === "/") {
        const uData = (await kv.get(["users", currentUser])).value as any;
        return new Response(`
        <!DOCTYPE html><html><head><title>Home</title>${commonHead}</head><body>${loaderHTML}
        <nav class="glass fixed top-0 w-full z-50 px-4 py-3 flex justify-between items-center shadow-lg">
            <div class="font-bold text-lg text-white">VIP 2D</div><div class="text-sm font-mono text-yellow-400">${(uData.balance||0).toLocaleString()} Ks</div>
        </nav>
        <div class="pt-20 px-4 pb-24 max-w-md mx-auto space-y-6">
            <a href="/football" class="glass p-3 rounded-xl border border-green-500/30 flex items-center justify-between group active:scale-95 transition-transform shadow-lg shadow-green-900/20">
                <div class="flex items-center gap-3"><div class="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 border border-green-500/50"><i class="fas fa-futbol text-lg animate-pulse"></i></div><div><div class="text-green-400 font-bold text-sm">Live Football</div><div class="text-[10px] text-gray-400">ဘောပွဲများ ကြည့်ရှုရန် နှိပ်ပါ</div></div></div><i class="fas fa-chevron-right text-gray-500 group-hover:text-white transition"></i>
            </a>
            <div class="glass rounded-3xl p-6 text-center relative overflow-hidden group">
                <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-yellow-500 to-transparent opacity-50"></div>
                <div class="flex justify-between text-xs text-gray-400 mb-2 font-mono"><span id="live_date">${SERVER_TODAY_KEY}</span><span class="text-red-500 animate-pulse font-bold">● LIVE</span></div>
                <div class="flex justify-center gap-2 text-8xl font-bold text-white font-mono drop-shadow-lg tracking-tighter h-32 overflow-hidden"><span id="d1" class="inline-block">--</span><span id="d2" class="inline-block"></span></div>
                <div class="text-xs text-gray-500 mt-2 font-mono" id="live_time">--:--:--</div>
                <div class="grid grid-cols-2 gap-2 mt-4 pt-4 border-t border-white/5">
                    <div class="bg-black/20 rounded-lg p-2"><div class="text-[10px] text-gray-500">09:30 AM</div><div class="font-bold text-lg text-yellow-500" id="res_930">--</div></div>
                    <div class="bg-black/20 rounded-lg p-2"><div class="text-[10px] text-gray-500">12:01 PM</div><div class="font-bold text-lg text-white" id="res_12">--</div></div>
                    <div class="bg-black/20 rounded-lg p-2"><div class="text-[10px] text-gray-500">02:00 PM</div><div class="font-bold text-lg text-yellow-500" id="res_200">--</div></div>
                    <div class="bg-black/20 rounded-lg p-2"><div class="text-[10px] text-gray-500">04:30 PM</div><div class="font-bold text-lg text-white" id="res_430">--</div></div>
                </div>
            </div>
            ${isAdmin ? `<div class="glass p-4 rounded-xl space-y-2"><h3 class="text-xs font-bold text-gray-400">Admin</h3><form action="/admin/clear_today_history" method="POST" onsubmit="adminSubmit(event)"><button class="w-full bg-red-900 text-white text-xs py-2 rounded">Clear Today History</button></form></div>` : ''}
        </div>
        ${navHTML}
        <script>
            const API = "https://api.thaistock2d.com/live";
            const SERVER_TODAY = "${SERVER_TODAY_KEY}";
            let lastM = "--", lastE = "--";
            startClock();
            function upL() {
                fetch(API).then(r=>r.json()).then(d=>{
                    if(d.live && d.live.date !== SERVER_TODAY) {
                        updateNumberWithAnimation("--"); 
                        document.getElementById('res_930').innerText = "--";
                        document.getElementById('res_12').innerText = "--";
                        document.getElementById('res_200').innerText = "--";
                        document.getElementById('res_430').innerText = "--";
                        return;
                    }
                    if(d.result){
                        const r930 = d.result[0]?.twod || "--";
                        const r12 = d.result[1]?.twod || "--";
                        const r200 = d.result[2]?.twod || "--";
                        const r430 = (d.result[3] || d.result[2])?.twod || "--";
                        document.getElementById('res_930').innerText = r930;
                        document.getElementById('res_12').innerText = r12;
                        document.getElementById('res_200').innerText = r200;
                        document.getElementById('res_430').innerText = r430;
                        if(d.live) updateNumberWithAnimation(d.live.status==='1' ? d.live.twod : "--");
                    }
                });
            }
            setInterval(upL, 2000); upL();
        </script>
        </body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    
    // --- HISTORY & PROFILE ---
    if (url.pathname === "/history") {
        try {
          const r = await fetch("https://api.thaistock2d.com/2d_result"); const apiData = await r.json();
          let htmlList = "";
          for (const day of apiData) {
              let m = "--", e = "--";
              if(day.child) {
                  const mObj = day.child.find((c:any) => c.time.startsWith("12:01"));
                  const eObj = day.child.find((c:any) => c.time.startsWith("16:30") || c.time.startsWith("04:30"));
                  if(mObj) m = mObj.twod; if(eObj) e = eObj.twod;
              }
              htmlList += `<div class="grid grid-cols-3 p-3 text-center items-center border-b border-white/5"><div class="text-xs text-gray-400">${day.date}</div><div class="font-bold text-lg text-white">${m}</div><div class="font-bold text-lg text-yellow-500">${e}</div></div>`;
          }
          return new Response(`<!DOCTYPE html><html><head><title>History</title>${commonHead}</head><body>${loaderHTML}${navHTML}<div class="p-4 pt-20 pb-20"><h2 class="text-center text-white font-bold mb-4">History</h2><div class="glass rounded-xl overflow-hidden">${htmlList}</div></div></body></html>`, {headers:{"Content-Type":"text/html"}});
        } catch { return new Response("Error loading history", {status:500}); }
    }
    
    if (url.pathname === "/profile") {
        const uData = (await kv.get(["users", currentUser])).value as any;
        return new Response(`<!DOCTYPE html><html><head><title>Profile</title>${commonHead}</head><body>${loaderHTML}${navHTML}<div class="p-6 pt-20"><div class="glass p-6 rounded-2xl text-center"><div class="w-20 h-20 mx-auto bg-gray-700 rounded-full flex items-center justify-center text-2xl text-white font-bold mb-2">${currentUser[0].toUpperCase()}</div><h2 class="text-xl font-bold text-white">${currentUser}</h2><div class="text-yellow-400 font-mono text-lg mt-1">${(uData.balance||0).toLocaleString()} Ks</div><button onclick="doLogout()" class="mt-6 bg-red-600 text-white px-6 py-2 rounded-lg font-bold">Logout</button></div></div></body></html>`, {headers:{"Content-Type":"text/html"}});
    }

  } catch(e) { return new Response("Error: "+e.message, {status:500}); }
  return new Response("404", {status:404});
});
