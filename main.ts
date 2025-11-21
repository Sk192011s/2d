import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const kv = await Deno.openKv();

// --- HELPERS ---
async function hashPassword(password: string, salt: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function generateId() { return crypto.randomUUID(); }
async function isRateLimited(req: Request, limitType: string, maxRequests: number) {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const key = ["ratelimit", limitType, ip];
  const entry = await kv.get(key);
  const current = (entry.value as number) || 0;
  if (current >= maxRequests) return true;
  await kv.set(key, current + 1, { expireIn: 60000 }); 
  return false;
}

// --- CRON JOB ---
Deno.cron("Save History", "*/10 * * * *", async () => {
  try {
    const res = await fetch("https://api.thaistock2d.com/live");
    const data = await res.json();
    const now = new Date();
    const mmDate = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Yangon" }));
    const dateKey = mmDate.getFullYear() + "-" + String(mmDate.getMonth() + 1).padStart(2, '0') + "-" + String(mmDate.getDate()).padStart(2, '0');
    
    const day = mmDate.getDay();
    if (day === 0 || day === 6) return; 

    let morning = "--";
    let evening = "--";

    if (data.result) {
        if (data.result[1]?.twod) morning = data.result[1].twod;
        const ev = data.result[3] || data.result[2];
        if (ev?.twod) evening = ev.twod;
    }

    if (morning !== "--" || evening !== "--") {
        const existing = await kv.get(["history", dateKey]);
        const oldVal = existing.value as any || { morning: "--", evening: "--" };
        await kv.set(["history", dateKey], {
            morning: morning !== "--" ? morning : oldVal.morning,
            evening: evening !== "--" ? evening : oldVal.evening,
            date: dateKey
        });
    }
  } catch (e) { console.error(e); }
});

serve(async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/reset_admin") {
      await kv.delete(["users", "admin"]);
      return new Response("Admin Deleted.", { status: 200 });
  }
  
  const cookieOptions = "; Path=/; HttpOnly; Max-Age=1296000"; 

  // AUTH ROUTES
  if (req.method === "POST" && url.pathname === "/register") {
    if (await isRateLimited(req, "register", 5)) return new Response("Too many attempts", { status: 429 });
    const form = await req.formData();
    const username = form.get("username")?.toString().trim();
    const password = form.get("password")?.toString();
    const remember = form.get("remember") === "on";

    if (!username || !password) return Response.redirect(url.origin + "/?error=missing_fields");
    const userEntry = await kv.get(["users", username]);
    if (userEntry.value) return Response.redirect(url.origin + "/?error=user_exists");

    const salt = generateId();
    const hashedPassword = await hashPassword(password, salt);
    await kv.set(["users", username], { passwordHash: hashedPassword, salt: salt, balance: 0, avatar: "" });
    
    const newSessionId = generateId();
    const maxAge = remember ? 1296000 : 86400; 
    await kv.set(["sessions", newSessionId], username, { expireIn: maxAge });
    
    const headers = new Headers({ "Location": "/" });
    headers.set("Set-Cookie", `session_id=${newSessionId}; Path=/; HttpOnly; Max-Age=${maxAge}; SameSite=Lax`);
    headers.append("Set-Cookie", `user=${encodeURIComponent(username)}; Path=/; Max-Age=${maxAge}`);
    return new Response(null, { status: 303, headers });
  }

  if (req.method === "POST" && url.pathname === "/login") {
    if (await isRateLimited(req, "login", 10)) return new Response("Too many attempts", { status: 429 });
    const form = await req.formData();
    const username = form.get("username")?.toString().trim();
    const password = form.get("password")?.toString();
    const remember = form.get("remember") === "on";

    const userEntry = await kv.get(["users", username]);
    const userData = userEntry.value as any;

    if (!userData) return Response.redirect(url.origin + "/?error=invalid_login");

    const inputHash = await hashPassword(password, userData.salt || "");
    const isValid = userData.passwordHash ? (inputHash === userData.passwordHash) : (password === userData.password);

    if (!isValid) return Response.redirect(url.origin + "/?error=invalid_login");

    if (!userData.passwordHash) {
        const salt = generateId();
        const newHash = await hashPassword(password, salt);
        const { password: _, ...rest } = userData;
        await kv.set(["users", username], { ...rest, passwordHash: newHash, salt: salt });
    }

    const newSessionId = generateId();
    const maxAge = remember ? 1296000 : 86400;
    await kv.set(["sessions", newSessionId], username, { expireIn: maxAge });

    const headers = new Headers({ "Location": "/" });
    headers.set("Set-Cookie", `session_id=${newSessionId}; Path=/; HttpOnly; Max-Age=${maxAge}; SameSite=Lax`);
    headers.append("Set-Cookie", `user=${encodeURIComponent(username)}; Path=/; Max-Age=${maxAge}`);
    return new Response(null, { status: 303, headers });
  }

  if (url.pathname === "/logout") {
    const cookies = req.headers.get("Cookie") || "";
    const sessionMatch = cookies.match(/session_id=([^;]+)/);
    if (sessionMatch) await kv.delete(["sessions", sessionMatch[1]]);
    const headers = new Headers({ "Location": "/" });
    headers.set("Set-Cookie", `session_id=; Path=/; Max-Age=0`);
    return new Response(null, { status: 303, headers });
  }

  // CHECK SESSION
  const cookies = req.headers.get("Cookie") || "";
  const sessionMatch = cookies.match(/session_id=([^;]+)/);
  const sessionId = sessionMatch ? sessionMatch[1] : null;
  
  let currentUser = null;
  if (sessionId) {
      const sessionEntry = await kv.get(["sessions", sessionId]);
      if (sessionEntry.value) {
          currentUser = sessionEntry.value as string;
          await kv.set(["sessions", sessionId], currentUser, { expireIn: 1296000 }); 
      }
  }
  const isAdmin = currentUser === "admin";

  // ACTIONS
  if (req.method === "POST" && url.pathname === "/update_avatar" && currentUser) {
      const form = await req.formData();
      const imageData = form.get("avatar")?.toString(); 
      if (imageData) {
          const userEntry = await kv.get(["users", currentUser]);
          const userData = userEntry.value as any;
          await kv.set(["users", currentUser], { ...userData, avatar: imageData });
          return new Response(JSON.stringify({ status: "success" }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ status: "error" }), { headers: { "content-type": "application/json" } });
  }

  if (req.method === "POST" && url.pathname === "/change_password" && currentUser) {
      const form = await req.formData();
      const newPass = form.get("new_password")?.toString();
      if (newPass && newPass.length >= 6) {
          const userEntry = await kv.get(["users", currentUser]);
          const userData = userEntry.value as any;
          const salt = generateId();
          const hashedPassword = await hashPassword(newPass, salt);
          await kv.set(["users", currentUser], { ...userData, passwordHash: hashedPassword, salt: salt });
          return Response.redirect(url.origin + "/profile?status=pass_changed");
      }
      return Response.redirect(url.origin + "/profile?status=error");
  }

  if (req.method === "POST" && url.pathname === "/clear_history" && currentUser) {
      const iter = kv.list({ prefix: ["bets"] });
      let deletedCount = 0;
      for await (const entry of iter) {
          const bet = entry.value as any;
          if (bet.user === currentUser && bet.status !== "PENDING") {
              await kv.delete(entry.key);
              deletedCount++;
          }
      }
      return new Response(JSON.stringify({ status: "cleared", count: deletedCount }), { headers: { "content-type": "application/json" } });
  }

  if (req.method === "POST" && url.pathname === "/bet" && currentUser) {
    if (await isRateLimited(req, "bet", 60)) return new Response(JSON.stringify({ status: "slow_down" }), { headers: { "content-type": "application/json" } });

    const now = new Date();
    const mmString = now.toLocaleString("en-US", { timeZone: "Asia/Yangon", hour12: false });
    const timePart = mmString.split(", ")[1];
    const [h, m] = timePart.split(":").map(Number);
    const totalMins = h * 60 + m;
    const isMorningClose = totalMins >= 710 && totalMins < 735; 
    const isEveningClose = totalMins >= 950 || totalMins < 480; 
    if (isMorningClose || isEveningClose) return new Response(JSON.stringify({ status: "market_closed" }), { headers: { "content-type": "application/json" } });

    const form = await req.formData();
    const numbersRaw = form.get("number")?.toString() || ""; 
    const amount = parseInt(form.get("amount")?.toString() || "0");
    
    if(!numbersRaw || amount <= 0) return new Response(JSON.stringify({ status: "invalid_bet" }), { headers: { "content-type": "application/json" } });
    if (amount < 50) return new Response(JSON.stringify({ status: "error_min" }), { headers: { "content-type": "application/json" } });
    if (amount > 100000) return new Response(JSON.stringify({ status: "error_max" }), { headers: { "content-type": "application/json" } });

    const numberList = numbersRaw.split(",").filter(n => n.trim() !== "");
    for (const num of numberList) {
        const isBlocked = await kv.get(["blocks", num.trim()]);
        if (isBlocked.value) return new Response(JSON.stringify({ status: "blocked", num: num.trim() }), { headers: { "content-type": "application/json" } });
    }

    const totalCost = numberList.length * amount;
    const userEntry = await kv.get(["users", currentUser]);
    const userData = userEntry.value as any;
    const currentBalance = userData?.balance || 0;

    if (currentBalance < totalCost) return new Response(JSON.stringify({ status: "insufficient_balance" }), { headers: { "content-type": "application/json" } });

    await kv.set(["users", currentUser], { ...userData, balance: currentBalance - totalCost });
    const timeString = new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon", hour: 'numeric', minute: 'numeric', hour12: true });
    const dateString = new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });

    for (const num of numberList) {
        const betId = Date.now().toString() + Math.random().toString().substr(2, 5);
        await kv.set(["bets", betId], { user: currentUser, number: num.trim(), amount, status: "PENDING", time: timeString, rawMins: totalMins });
    }
    return new Response(JSON.stringify({ status: "success", voucher: { user: currentUser, date: dateString, time: timeString, numbers: numberList, amountPerNum: amount, total: totalCost, id: Date.now().toString().slice(-6) } }), { headers: { "content-type": "application/json" } });
  }

  // ADMIN ACTIONS
  if (isAdmin && req.method === "POST") {
    if (url.pathname === "/admin/topup") {
      const form = await req.formData();
      const targetUser = form.get("username")?.toString().trim();
      const amount = parseInt(form.get("amount")?.toString() || "0");
      if(targetUser) {
        const userEntry = await kv.get(["users", targetUser]);
        const userData = userEntry.value as any;
        if(userData) {
            await kv.set(["users", targetUser], { ...userData, balance: (userData.balance || 0) + amount });
            await kv.set(["transactions", Date.now().toString()], { user: targetUser, amount: amount, type: "TOPUP", time: new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon" }) });
        }
      }
      return new Response(null, { status: 303, headers: { "Location": "/profile" } });
    }
    if (url.pathname === "/admin/reset_pass") {
        const form = await req.formData();
        const targetUser = form.get("username")?.toString().trim();
        const newPass = form.get("password")?.toString();
        if (targetUser && newPass) {
            const userEntry = await kv.get(["users", targetUser]);
            const userData = userEntry.value as any;
            if (userData) {
                const salt = generateId();
                const hashedPassword = await hashPassword(newPass, salt);
                await kv.set(["users", targetUser], { ...userData, passwordHash: hashedPassword, salt: salt });
            }
        }
        return new Response(null, { status: 303, headers: { "Location": "/profile" } });
    }
    if (url.pathname === "/admin/contact") {
        const form = await req.formData();
        const contactData = { kpay_name: form.get("kpay_name")||"Admin", kpay_no: form.get("kpay_no")||"09-", kpay_img: form.get("kpay_img")||"", wave_name: form.get("wave_name")||"Admin", wave_no: form.get("wave_no")||"09-", wave_img: form.get("wave_img")||"", tele_link: form.get("tele_link")||"#" };
        await kv.set(["system", "contact"], contactData);
        return new Response(null, { status: 303, headers: { "Location": "/profile" } });
    }
    if (url.pathname === "/admin/rate") {
        const form = await req.formData();
        const rate = parseInt(form.get("rate")?.toString() || "80");
        await kv.set(["system", "rate"], rate);
        return new Response(null, { status: 303, headers: { "Location": "/profile" } });
    }
    if (url.pathname === "/admin/payout") {
      const form = await req.formData();
      const winNumber = form.get("win_number")?.toString();
      const session = form.get("session")?.toString(); 
      const rateEntry = await kv.get(["system", "rate"]);
      const payoutRate = (rateEntry.value as number) || 80;
      const iter = kv.list({ prefix: ["bets"] });
      for await (const entry of iter) {
        const bet = entry.value as any;
        if (bet.status === "PENDING") {
          const betMins = bet.rawMins || 0;
          const isMorningBet = betMins < 735;
          let processBet = false;
          if (session === "MORNING" && isMorningBet) processBet = true;
          if (session === "EVENING" && !isMorningBet) processBet = true;
          if (processBet) {
             if (bet.number === winNumber) {
                const winAmount = bet.amount * payoutRate;
                const userEntry = await kv.get(["users", bet.user]);
                const userData = userEntry.value as any;
                await kv.set(["users", bet.user], { ...userData, balance: (userData.balance || 0) + winAmount });
                await kv.set(["bets", entry.key[1]], { ...bet, status: "WIN", winAmount });
             } else {
                await kv.set(["bets", entry.key[1]], { ...bet, status: "LOSE" });
             }
          }
        }
      }
      return new Response(null, { status: 303, headers: { "Location": "/profile" } });
    }
    if (url.pathname === "/admin/block") {
        const form = await req.formData();
        const action = form.get("action")?.toString();
        const val = form.get("block_val")?.toString() || "";
        const type = form.get("block_type")?.toString() || "direct";
        if (action === "clear") { const iter = kv.list({ prefix: ["blocks"] }); for await (const entry of iter) await kv.delete(entry.key); } 
        else if (action === "unblock" && val) { await kv.delete(["blocks", val]); } 
        else if (action === "add" && val) {
            let numsToBlock = [];
            if (type === "direct") numsToBlock.push(val.padStart(2, '0'));
            else if (type === "head") for(let i=0; i<10; i++) numsToBlock.push(val + i);
            else if (type === "tail") for(let i=0; i<10; i++) numsToBlock.push(i + val);
            for (const n of numsToBlock) { if(n.length === 2) await kv.set(["blocks", n], true); }
        }
        return new Response(null, { status: 303, headers: { "Location": "/profile" } });
    }
    if (url.pathname === "/admin/tip") {
        const form = await req.formData();
        const tip = form.get("tip")?.toString();
        await kv.set(["system", "tip"], tip);
        return new Response(null, { status: 303, headers: { "Location": "/profile" } });
    }
    if (url.pathname === "/admin/add_history") {
      const form = await req.formData();
      const date = form.get("date")?.toString(); 
      const morning = form.get("morning")?.toString() || "--";
      const evening = form.get("evening")?.toString() || "--";
      if (date) await kv.set(["history", date], { morning, evening, date });
      return new Response(null, { status: 303, headers: { "Location": "/profile" } });
    }
  }

  // =========================
  // 5. UI RENDERING
  // =========================
  const commonHead = `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
        body { font-family: 'Inter', sans-serif; background-color: #0f172a; color: white; -webkit-tap-highlight-color: transparent; padding-bottom: 80px; }
        .bg-card { background-color: #1f2937; }
        .text-gold { color: #fbbf24; text-shadow: 0 0 10px rgba(251, 191, 36, 0.3); }
        .btn-primary { background: linear-gradient(to right, #3b82f6, #2563eb); color: white; box-shadow: 0 4px 15px rgba(37, 99, 235, 0.3); }
        .btn-gold { background: linear-gradient(to right, #f59e0b, #d97706); color: white; box-shadow: 0 4px 15px rgba(245, 158, 11, 0.3); }
        .bottom-nav { position: fixed; bottom: 0; left: 0; width: 100%; background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(10px); border-top: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-around; padding: 12px 0; z-index: 50; }
        .nav-item { display: flex; flex-direction: column; align-items: center; color: #64748b; font-size: 10px; transition: color 0.3s; }
        .nav-item.active { color: #3b82f6; }
        .nav-item i { font-size: 20px; margin-bottom: 2px; }
        
        /* KEYFRAME ANIMATION FOR FADE OUT */
        @keyframes fadeOut { to { opacity: 0; visibility: hidden; } }
        .splash-fade-out { animation: fadeOut 0.5s ease-out 2.5s forwards; pointer-events: none; }

        #splash-screen { position: fixed; inset: 0; background-color: #0f172a; z-index: 10000; display: flex; flex-direction: column; align-items: center; justify-content: center; }
        
        .animate-gradient-x { background-size: 200% 200%; animation: gradient-move 3s ease infinite; }
        @keyframes gradient-move { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        .swal2-popup.swal2-toast { background: #1e293b !important; color: white !important; border: 1px solid rgba(255,255,255,0.1); }
        ::-webkit-scrollbar { width: 0px; }
    </style>
    <script>
        const Toast = Swal.mixin({ toast: true, position: 'top', showConfirmButton: false, timer: 3000, timerProgressBar: true });
    </script>
  `;
  
  // SPLASH SCREEN HTML WITH AUTO FADE OUT CLASS
  const splashHTML = `
    <div id="splash-screen" class="splash-fade-out">
        <div class="w-24 h-24 bg-blue-600 rounded-2xl flex items-center justify-center mb-4 shadow-2xl shadow-blue-500/50">
            <i class="fas fa-chart-line text-4xl text-white"></i>
        </div>
        <h1 class="text-2xl font-bold text-white tracking-widest">MYANMAR 2D</h1>
        <p class="text-blue-400 text-xs mt-2 uppercase tracking-widest">Premium Betting</p>
    </div>
  `;

  // LOGIN PAGE
  if (!currentUser) {
    return new Response(`<!DOCTYPE html><html><head><title>Welcome</title>${commonHead}</head><body class="h-screen flex items-center justify-center px-4 bg-slate-900">${splashHTML}<div class="glass-card w-full max-w-sm p-8 rounded-3xl text-center border-2 border-slate-600"><div class="w-16 h-16 bg-blue-600 rounded-xl mx-auto mb-4 flex items-center justify-center shadow-lg shadow-blue-500/30"><i class="fas fa-chart-line text-2xl text-white"></i></div><h1 class="text-2xl font-bold text-white mb-1">Welcome Back</h1><p class="text-slate-400 text-sm mb-8">Sign in to continue</p><div class="flex justify-center mb-6 bg-slate-800/50 p-1 rounded-xl border border-slate-600"><button onclick="showLogin()" id="tabLogin" class="w-1/2 py-2 rounded-lg font-bold text-sm bg-blue-600 text-white shadow-md">Login</button><button onclick="showRegister()" id="tabReg" class="w-1/2 py-2 rounded-lg font-bold text-sm text-slate-400">Register</button></div><form id="loginForm" action="/login" method="POST"><div class="space-y-4"><input name="username" placeholder="Username" class="w-full bg-slate-800/50 border-2 border-slate-600 text-white p-3 rounded-xl outline-none focus:border-blue-500 transition" required><input type="password" name="password" placeholder="Password" class="w-full bg-slate-800/50 border-2 border-slate-600 text-white p-3 rounded-xl outline-none focus:border-blue-500 transition" required><label class="flex items-center gap-2 text-xs text-slate-400 cursor-pointer"><input type="checkbox" name="remember" checked class="rounded bg-slate-700 border-slate-600 text-blue-600"> Remember Me (15 Days)</label><button class="w-full btn-primary py-3.5 rounded-xl font-bold mt-2 shadow-lg shadow-blue-500/30">SIGN IN</button></div></form><form id="regForm" action="/register" method="POST" class="hidden"><div class="space-y-4"><input name="username" placeholder="Choose Username" class="w-full bg-slate-800/50 border-2 border-slate-600 text-white p-3 rounded-xl outline-none focus:border-blue-500 transition" required><input type="password" name="password" placeholder="Choose Password" class="w-full bg-slate-800/50 border-2 border-slate-600 text-white p-3 rounded-xl outline-none focus:border-blue-500 transition" required><label class="flex items-center gap-2 text-xs text-slate-400 cursor-pointer"><input type="checkbox" name="remember" checked class="rounded bg-slate-700 border-slate-600 text-blue-600"> Remember Me (15 Days)</label><button class="w-full btn-primary py-3.5 rounded-xl font-bold mt-2 shadow-lg shadow-blue-500/30">CREATE ACCOUNT</button></div></form></div><script>const p=new URLSearchParams(window.location.search);if(p.get('error'))Toast.fire({icon:'error',title:p.get('error')});function showLogin(){document.getElementById('loginForm').classList.remove('hidden');document.getElementById('regForm').classList.add('hidden');const l=document.getElementById('tabLogin'),r=document.getElementById('tabReg');l.className='w-1/2 py-2 rounded-lg font-bold text-sm bg-blue-600 text-white shadow-md';r.className='w-1/2 py-2 rounded-lg font-bold text-sm text-slate-400';}function showRegister(){document.getElementById('loginForm').classList.add('hidden');document.getElementById('regForm').classList.remove('hidden');const l=document.getElementById('tabLogin'),r=document.getElementById('tabReg');r.className='w-1/2 py-2 rounded-lg font-bold text-sm bg-blue-600 text-white shadow-md';l.className='w-1/2 py-2 rounded-lg font-bold text-sm text-slate-400';}</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const userEntry = await kv.get(["users", currentUser]);
  const userData = userEntry.value as any;
  const balance = userData?.balance || 0;
  const avatar = userData?.avatar || "";
  const page = url.pathname;
  const activeClass = (p: string) => page === p ? "active" : "";
  
  // NAV BAR
  const navHTML = `
    <div class="bottom-nav">
        <a href="/" class="nav-item ${activeClass('/')}"><i class="fas fa-home"></i><span>Home</span></a>
        <a href="/history" class="nav-item ${activeClass('/history')}"><i class="fas fa-clock"></i><span>History</span></a>
        <a href="/profile" class="nav-item ${activeClass('/profile')}"><i class="fas fa-user"></i><span>Profile</span></a>
    </div>
  `;

  let content = "";
  
  if (page === "/history") {
      const historyList = [];
      const hIter = kv.list({ prefix: ["history"] }, { reverse: true });
      for await (const entry of hIter) historyList.push(entry.value);
      content = `
        <div class="p-4">
            <h2 class="text-xl font-bold text-white mb-4 tracking-wide">2D History</h2>
            <div class="glass-card rounded-xl overflow-hidden border-2 border-slate-600">
                <div class="grid grid-cols-3 bg-slate-800/80 p-3 text-[10px] font-bold text-slate-300 text-center tracking-wider border-b border-slate-600"><div>DATE</div><div>12:01 PM</div><div>04:30 PM</div></div>
                ${historyList.map((h: any) => `<div class="grid grid-cols-3 p-3 text-center border-t border-slate-700 items-center"><div class="text-xs text-slate-300 font-mono font-bold">${h.date}</div><div class="font-bold text-blue-400 text-lg">${h.morning}</div><div class="font-bold text-purple-400 text-lg">${h.evening}</div></div>`).join('')}
                ${historyList.length===0?'<div class="p-8 text-center text-slate-500 text-sm">No history records found.</div>':''}
            </div>
        </div>`;
  }
  else if (page === "/profile") {
      const transactions = [];
      const txIter = kv.list({ prefix: ["transactions"] }, { reverse: true, limit: 50 });
      for await (const entry of txIter) { if (entry.value.user === currentUser) transactions.push(entry.value); }
      const contactEntry = await kv.get(["system", "contact"]);
      const contact = contactEntry.value as any || { kpay_no: "", kpay_name: "", wave_no: "", wave_name: "", tele_link: "" };
      
      let adminStats = "";
      if (isAdmin) {
          const todayStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });
          let sale=0, payout=0;
          for await (const entry of kv.list({ prefix: ["bets"] })) {
             const b = entry.value as any;
             const d = new Date(parseInt(entry.key[1])).toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });
             if(d===todayStr) { sale+=b.amount; if(b.status==="WIN") payout+=(b.winAmount||0); }
          }
          adminStats = `<div class="glass-card p-3 rounded-xl mb-4 border-2 border-slate-600"><h3 class="text-xs font-bold text-slate-400 mb-2 uppercase">Today's Overview</h3><div class="grid grid-cols-3 gap-2"><div class="bg-green-500/10 p-2 rounded-lg text-center border border-green-500/30"><div class="text-[10px] text-green-400 font-bold">SALE</div><div class="font-bold text-sm">${sale.toLocaleString()}</div></div><div class="bg-red-500/10 p-2 rounded-lg text-center border border-red-500/30"><div class="text-[10px] text-red-400 font-bold">PAYOUT</div><div class="font-bold text-sm">${payout.toLocaleString()}</div></div><div class="bg-blue-500/10 p-2 rounded-lg text-center border border-blue-500/30"><div class="text-[10px] text-blue-400 font-bold">PROFIT</div><div class="font-bold text-sm">${(sale-payout).toLocaleString()}</div></div></div></div>`;
      }

      content = `
        <div class="bg-gradient-to-b from-blue-900 to-slate-900 p-6 pb-10 rounded-b-[40px] shadow-2xl text-center relative mb-4 border-b-2 border-blue-500/30">
            <div class="relative w-24 h-24 mx-auto mb-3">
                <div class="w-24 h-24 rounded-full bg-slate-800 border-4 border-blue-500/30 overflow-hidden flex items-center justify-center relative shadow-xl">${avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : `<i class="fas fa-user text-4xl text-slate-600"></i>`}</div>
                <button onclick="document.getElementById('pInput').click()" class="absolute bottom-0 right-0 bg-blue-500 text-white rounded-full p-2 shadow-lg hover:bg-blue-600 transition"><i class="fas fa-camera text-xs"></i></button>
                <input type="file" id="pInput" hidden accept="image/*" onchange="uploadAvatar(this)">
            </div>
            <h1 class="text-xl font-bold text-white tracking-wide">${currentUser}</h1>
            <div class="inline-block bg-slate-800/50 px-4 py-1 rounded-full mt-2 border border-white/10"><span class="text-gold font-bold text-sm">${balance.toLocaleString()} Ks</span></div>
        </div>
        <div class="px-4 space-y-4 pb-6">
            ${adminStats}
            ${isAdmin ? `
            <div class="glass-card p-4 rounded-xl border-2 border-slate-600">
                <h3 class="text-xs font-bold text-slate-400 mb-3 uppercase tracking-wider">Admin Control</h3>
                <form action="/admin/topup" method="POST" class="flex gap-2 mb-3"><input name="username" placeholder="User" class="w-1/3 bg-slate-800 border border-slate-600 rounded-lg p-2 text-xs text-white focus:border-blue-500 outline-none"><input name="amount" placeholder="Amount" type="number" class="w-1/3 bg-slate-800 border border-slate-600 rounded-lg p-2 text-xs text-white focus:border-blue-500 outline-none"><button class="bg-green-600 hover:bg-green-700 text-white w-1/3 rounded-lg text-xs font-bold transition shadow-md">TOPUP</button></form>
                <form action="/admin/payout" method="POST" class="flex gap-2 mb-3"><select name="session" class="w-1/3 bg-slate-800 border border-slate-600 rounded-lg p-2 text-xs text-white outline-none"><option value="MORNING">12:01</option><option value="EVENING">04:30</option></select><input name="win_number" placeholder="Win No" class="w-1/3 bg-slate-800 border border-slate-600 rounded-lg p-2 text-center text-xs text-white focus:border-blue-500 outline-none"><button class="bg-red-600 hover:bg-red-700 text-white w-1/3 rounded-lg text-xs font-bold transition shadow-md">PAYOUT</button></form>
                <form action="/admin/contact" method="POST" class="grid grid-cols-2 gap-2 mb-3"><input name="kpay_no" placeholder="KPay No" class="bg-slate-800 border border-slate-600 rounded-lg p-2 text-xs text-white"><input name="wave_no" placeholder="Wave No" class="bg-slate-800 border border-slate-600 rounded-lg p-2 text-xs text-white"><button class="col-span-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 text-xs font-bold transition shadow-md">Update Contact</button></form>
                <form action="/admin/tip" method="POST" class="flex gap-2"><input name="tip" placeholder="Lucky Tip Text" class="flex-1 bg-slate-800 border border-slate-600 rounded-lg p-2 text-xs text-white focus:border-blue-500 outline-none"><button class="bg-purple-600 hover:bg-purple-700 text-white px-4 rounded-lg text-xs font-bold transition shadow-md">TIP</button></form>
                <form action="/admin/add_history" method="POST" class="flex gap-2 mt-3"><input name="date" type="date" class="w-1/3 bg-slate-800 border-slate-600 rounded p-2 text-xs text-white"><input name="morning" placeholder="M" class="w-1/4 bg-slate-800 border-slate-600 rounded p-2 text-center text-xs text-white"><input name="evening" placeholder="E" class="w-1/4 bg-slate-800 border-slate-600 rounded p-2 text-center text-xs text-white"><button class="bg-gray-600 text-white w-1/6 rounded text-xs shadow-md">Save</button></form>
            </div>` : ''}

            <div class="glass-card p-4 rounded-xl border-2 border-slate-600">
                <h3 class="text-xs font-bold text-slate-400 mb-3 uppercase tracking-wider">Security</h3>
                <form action="/change_password" method="POST" class="flex gap-2"><input type="password" name="new_password" placeholder="New Password" class="flex-1 bg-slate-800 border border-slate-600 rounded-lg p-2 text-sm text-white focus:border-blue-500 outline-none" required><button class="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg text-xs font-bold transition shadow-md">CHANGE</button></form>
            </div>

            <div class="glass-card p-4 rounded-xl border-2 border-slate-600">
                <h3 class="text-xs font-bold text-slate-400 mb-3 uppercase tracking-wider">Contact Admin</h3>
                <div class="grid grid-cols-2 gap-2">
                    <div class="bg-blue-500/10 border border-blue-500/20 p-3 rounded-xl text-center"><div class="text-xs text-blue-400 font-bold mb-1">KPay</div><div class="text-sm font-bold text-white select-all">${contact.kpay_no}</div></div>
                    <div class="bg-yellow-500/10 border border-yellow-500/20 p-3 rounded-xl text-center"><div class="text-xs text-yellow-400 font-bold mb-1">Wave</div><div class="text-sm font-bold text-white select-all">${contact.wave_no}</div></div>
                    <a href="${contact.tele_link}" target="_blank" class="col-span-2 bg-blue-600 text-white p-3 rounded-xl text-center font-bold text-sm flex items-center justify-center gap-2 hover:bg-blue-700 transition shadow-lg shadow-blue-600/20"><i class="fab fa-telegram text-xl"></i> Contact on Telegram</a>
                </div>
            </div>

            <div class="glass-card p-4 rounded-xl border-2 border-slate-600">
                <h3 class="text-xs font-bold text-slate-400 mb-3 uppercase tracking-wider">Transaction History</h3>
                <div class="space-y-2 h-40 overflow-y-auto history-scroll">
                    ${transactions.length === 0 ? '<div class="text-center text-slate-600 text-xs py-4">No transactions</div>' : ''}
                    ${transactions.map(tx => `<div class="flex justify-between items-center p-3 bg-slate-800/50 rounded-lg border-l-2 ${tx.type==='TOPUP'?'border-green-500':'border-red-500'}"><div class="text-xs text-slate-400">${tx.time}</div><div class="font-bold text-sm text-white">+${tx.amount.toLocaleString()}</div></div>`).join('')}
                </div>
            </div>
        </div>
        <script>function uploadAvatar(input) { if(input.files && input.files[0]) { const file = input.files[0]; const reader = new FileReader(); reader.onload = function(e) { const img = new Image(); img.src = e.target.result; img.onload = function() { const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d'); const size = 150; canvas.width = size; canvas.height = size; let sSize = Math.min(img.width, img.height); let sx = (img.width - sSize) / 2; let sy = (img.height - sSize) / 2; ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, size, size); const dataUrl = canvas.toDataURL('image/jpeg', 0.7); const fd = new FormData(); fd.append('avatar', dataUrl); fetch('/update_avatar', { method: 'POST', body: fd }).then(res => res.json()).then(d => { if(d.status==='success') location.reload(); else Toast.fire({icon:'error',title:'Upload failed'}); }); } }; reader.readAsDataURL(file); } } const p = new URLSearchParams(window.location.search); if(p.get('status')==='pass_changed') Toast.fire({icon:'success',title:'Password Updated 🔒'});</script>
      `;
  }
  else {
      const bets = [];
      const iter = kv.list({ prefix: ["bets"] }, { reverse: true, limit: 50 });
      for await (const entry of iter) { if (isAdmin || entry.value.user === currentUser) bets.push(entry.value); }
      const tipEntry = await kv.get(["system", "tip"]);
      const dailyTip = tipEntry.value || "";

      content = `
        <div class="flex justify-between items-center px-5 py-4 sticky top-0 bg-slate-900/95 backdrop-blur-md z-40 border-b border-white/10 shadow-md">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-full bg-slate-800 overflow-hidden border-2 border-slate-500 shadow-sm">${avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : `<i class="fas fa-user text-gray-400 m-2"></i>`}</div>
                <div><div class="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Welcome</div><div class="text-sm font-bold text-white leading-none">${currentUser}</div></div>
            </div>
            <div class="bg-gradient-to-r from-slate-800 to-slate-900 px-4 py-2 rounded-lg border border-slate-600 flex items-center gap-2 shadow-inner">
                <i class="fas fa-wallet text-gold text-sm"></i>
                <span class="text-sm font-bold text-white">${balance.toLocaleString()} <span class="text-[10px] text-slate-400">Ks</span></span>
            </div>
        </div>

        <div class="p-4">
            <div class="glass-card rounded-2xl p-6 text-center shadow-lg relative overflow-hidden mb-5 border-2 border-slate-600">
              <div class="flex justify-between items-center mb-2 text-slate-300 text-[10px] font-bold uppercase tracking-widest"><span id="live_date">Today</span><span class="flex items-center gap-1 text-green-400"><i class="fas fa-circle text-[6px] animate-pulse"></i> Live</span></div>
              <div class="py-1"><div id="live_twod" class="text-7xl font-black tracking-widest text-white drop-shadow-2xl">--</div><div class="text-[10px] mt-2 text-slate-400 font-mono">Update: <span id="live_time">--:--:--</span></div></div>
            </div>

            ${dailyTip ? `<div class="mb-5 relative overflow-hidden rounded-xl shadow-lg transform hover:scale-[1.02] transition duration-300 border border-blue-500/30"><div class="absolute inset-0 bg-gradient-to-r from-cyan-500 via-blue-500 to-indigo-600 animate-gradient-x"></div><div class="relative bg-slate-900/90 m-[1px] rounded-xl p-3 text-center backdrop-blur-md"><span class="bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide mb-1 inline-block">VIP TIP</span><p class="text-lg font-bold text-white">${dailyTip}</p></div></div>` : ''}

            ${!isAdmin ? `<button onclick="openBetModal()" class="w-full btn-gold py-4 rounded-xl font-bold text-lg shadow-lg shadow-orange-500/20 mb-6 active:scale-95 transition flex items-center justify-center gap-2 border-t border-white/20"><i class="fas fa-plus-circle"></i> ထိုးမည် (Bet)</button>` : ''}

            <div class="grid grid-cols-2 gap-3 mb-6">
                <div class="glass-card p-4 rounded-xl flex flex-col items-center relative overflow-hidden group border-2 border-slate-600"><div class="absolute top-0 left-0 w-full h-1 bg-yellow-500/50"></div><div class="text-xs text-slate-400 font-bold mb-1">12:01 PM</div><div id="res_12" class="text-3xl font-bold text-white group-hover:text-gold transition">--</div><div id="set_12" class="text-[10px] text-slate-500 mt-1 font-mono">SET: --</div></div>
                <div class="glass-card p-4 rounded-xl flex flex-col items-center relative overflow-hidden group border-2 border-slate-600"><div class="absolute top-0 left-0 w-full h-1 bg-purple-500/50"></div><div class="text-xs text-slate-400 font-bold mb-1">04:30 PM</div><div id="res_430" class="text-3xl font-bold text-white group-hover:text-purple-400 transition">--</div><div id="set_430" class="text-[10px] text-slate-500 mt-1 font-mono">SET: --</div></div>
            </div>

            <div class="flex justify-between items-end mb-3">
                <h3 class="font-bold text-slate-400 text-xs uppercase tracking-wider flex items-center gap-2"><i class="fas fa-history"></i> Recent Bets</h3>
                <div class="flex gap-2">
                    <div class="relative"><input type="text" id="historySearch" onkeyup="filterHistory()" placeholder="Search No" class="bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-white w-28 text-center outline-none focus:border-blue-500 transition"></div>
                    <button onclick="confirmClearHistory()" class="bg-red-500/20 border border-red-500/30 text-red-400 p-1.5 rounded-lg hover:bg-red-500 hover:text-white transition flex items-center justify-center w-8 h-8"><i class="fas fa-trash-alt text-xs"></i></button>
                </div>
            </div>
            <div id="historyList" class="space-y-2.5 h-auto pb-24">
                ${bets.map(b => `<div class="history-item bg-slate-800 p-3.5 rounded-xl border-l-4 ${b.status==='WIN'?'border-green-500 bg-green-500/5':b.status==='LOSE'?'border-red-500 bg-red-500/5':'border-yellow-500'} flex justify-between items-center border border-slate-700 shadow-md"><div class="flex items-center gap-3"><div class="w-10 h-10 rounded-lg bg-slate-900 border border-slate-600 flex items-center justify-center text-lg font-bold text-white shadow-inner bet-number">${b.number}</div><div><div class="text-[10px] text-slate-400 font-bold uppercase tracking-wide">${b.status}</div><div class="text-[10px] text-slate-500 font-mono">${b.time}</div></div></div><div class="text-right"><div class="text-gold font-bold text-sm">${b.amount.toLocaleString()}</div><div class="text-[10px] text-slate-500">Ks</div></div></div>`).join('')}
                ${bets.length===0?'<div class="text-center text-slate-600 text-xs mt-10 border-2 border-dashed border-slate-800 rounded-xl p-6">No bets placed yet</div>':''}
            </div>
        </div>
        
        <div id="betModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm hidden z-[60] flex items-end justify-center"><div class="bg-slate-900 w-full rounded-t-3xl p-6 border-t border-slate-700 shadow-2xl h-auto max-h-[85vh] overflow-y-auto"><div class="flex justify-between items-center mb-6"><h2 class="text-lg font-bold text-white">Place Bet</h2><button onclick="closeBetModal()" class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 hover:bg-slate-700"><i class="fas fa-times"></i></button></div>
        <div class="flex gap-2 mb-5 p-1 bg-slate-800 rounded-xl"><button onclick="setTab('direct')" id="btnDirect" class="flex-1 py-2.5 rounded-lg bg-blue-600 text-white font-bold text-xs shadow-lg transition">Direct</button><button onclick="setTab('quick')" id="btnQuick" class="flex-1 py-2.5 rounded-lg text-slate-400 font-bold text-xs hover:text-white transition">Quick</button></div>
        <form id="betForm" onsubmit="placeBet(event)"><div id="tabDirectContent"><textarea id="numberInput" name="number" class="w-full h-32 bg-slate-800 border-2 border-slate-600 rounded-xl p-4 text-white text-xl font-bold tracking-widest focus:border-blue-500 outline-none transition placeholder-slate-600" placeholder="12, 34, 56"></textarea></div><div id="tabQuickContent" class="hidden grid grid-cols-4 gap-2 mb-2"><button type="button" onclick="quickBet('head')" class="bg-slate-800 hover:bg-slate-700 text-white p-3 rounded-xl text-xs font-bold transition border border-slate-700">Head</button><button type="button" onclick="quickBet('tail')" class="bg-slate-800 hover:bg-slate-700 text-white p-3 rounded-xl text-xs font-bold transition border border-slate-700">Tail</button><button type="button" onclick="quickBet('double')" class="bg-slate-800 hover:bg-slate-700 text-white p-3 rounded-xl text-xs font-bold transition border border-slate-700">Double</button><button type="button" onclick="quickBet('brake')" class="bg-slate-800 hover:bg-slate-700 text-white p-3 rounded-xl text-xs font-bold transition border border-slate-700">Brake</button><div id="quickInputArea" class="col-span-4 hidden flex gap-2 mt-2 p-2 bg-slate-800 rounded-xl border border-slate-700"><input type="number" id="quickVal" class="flex-1 bg-transparent border-none text-white text-center font-bold outline-none placeholder-slate-500" placeholder="Type Number..."><button type="button" onclick="generateNumbers()" class="bg-blue-600 text-white px-4 py-2 rounded-lg font-bold text-xs">ADD</button></div></div><div class="mt-6 mb-10"><div class="relative"><input type="number" name="amount" class="w-full bg-slate-800 border-2 border-slate-600 rounded-xl p-4 text-white text-center text-xl font-bold mb-4 focus:border-green-500 outline-none transition" placeholder="0" required><span class="absolute right-4 top-4 text-slate-500 font-bold text-sm mt-1">Ks</span></div><button class="w-full btn-gold py-4 rounded-xl font-bold text-lg shadow-lg shadow-orange-500/20 active:scale-95 transition">CONFIRM BET</button></div></form></div></div>
        
        <div id="voucherModal" class="fixed inset-0 bg-black/90 backdrop-blur-md hidden z-[70] flex items-center justify-center p-5"><div class="bg-white w-full max-w-sm rounded-2xl overflow-hidden relative shadow-2xl"><button onclick="closeVoucher()" class="absolute top-3 right-4 text-gray-400 text-2xl hover:text-gray-600">&times;</button><div id="voucherContent" class="p-6 text-gray-800"></div><div class="bg-gray-50 p-4"><button onclick="closeVoucher()" class="bg-slate-900 text-white w-full py-3 rounded-xl font-bold shadow-lg">Close & Save</button></div></div></div>
        
        <script>
            const p = new URLSearchParams(window.location.search);
            if(p.get('status')==='pass_changed') Toast.fire({icon:'success',title:'Password Updated 🔒'});
            
            function setTab(t) { const d=document.getElementById('tabDirectContent'), q=document.getElementById('tabQuickContent'), bd=document.getElementById('btnDirect'), bq=document.getElementById('btnQuick'); if(t==='direct'){d.classList.remove('hidden');q.classList.add('hidden');bd.className="flex-1 py-2.5 rounded-lg bg-blue-600 text-white font-bold text-xs shadow-lg transition";bq.className="flex-1 py-2.5 rounded-lg text-slate-400 font-bold text-xs hover:text-white transition";}else{d.classList.add('hidden');q.classList.remove('hidden');bd.className="flex-1 py-2.5 rounded-lg text-slate-400 font-bold text-xs hover:text-white transition";bq.className="flex-1 py-2.5 rounded-lg bg-blue-600 text-white font-bold text-xs shadow-lg transition";} }
            
            function openBetModal(){ document.getElementById('betModal').classList.remove('hidden'); }
            function closeBetModal(){ document.getElementById('betModal').classList.add('hidden'); }
            function closeVoucher(){ document.getElementById('voucherModal').classList.add('hidden'); window.location.reload(); }
            
            let qMode=''; function quickBet(m){ const a=document.getElementById('quickInputArea'); if(m==='double'){addNums(genDouble());a.classList.add('hidden');}else{qMode=m;a.classList.remove('hidden');document.getElementById('quickVal').focus();} }
            function generateNumbers(){ const v=document.getElementById('quickVal').value; if(!v)return; let n=[]; if(qMode==='head')n=genHead(v); if(qMode==='tail')n=genTail(v); if(qMode==='brake')n=genBrake(v); addNums(n); document.getElementById('quickVal').value=''; }
            function addNums(n){ const i=document.getElementById('numberInput'); let c=i.value.trim(); if(c&&!c.endsWith(','))c+=','; i.value=c+n.join(','); }
            function genHead(d){let r=[];for(let i=0;i<10;i++)r.push(d+i);return r;} function genTail(d){let r=[];for(let i=0;i<10;i++)r.push(i+d);return r;} function genDouble(){let r=[];for(let i=0;i<10;i++)r.push(i+""+i);return r;} function genBrake(n){if(n.length!==2)return[];const r=n[1]+n[0];return n===r?[n]:[n,r];}
            
            async function placeBet(e){ 
                e.preventDefault(); 
                
                // MANUAL SPINNER START
                const btn = e.target.querySelector('button');
                const originalText = btn.innerHTML;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
                btn.disabled = true;

                const fd=new FormData(e.target); 
                try{ 
                    const res=await fetch('/bet',{method:'POST',body:fd}); 
                    if(!res.ok) throw new Error("Server Error");
                    const d=await res.json(); 
                    
                    // SPINNER STOP
                    btn.innerHTML = originalText;
                    btn.disabled = false;

                    if(d.status==='success'){ closeBetModal(); Toast.fire({icon:'success',title:'Bet Placed! 🍀'}); showVoucher(d.voucher); }
                    else if(d.status==='blocked') Swal.fire({icon:'error',title:'Blocked',text:'Number '+d.num+' is closed',confirmButtonColor:'#d33'});
                    else if(d.status==='insufficient_balance') Swal.fire({icon:'error',title:'Error',text:'Insufficient Balance',confirmButtonColor:'#d33'});
                    else if(d.status==='market_closed') Swal.fire({icon:'warning',title:'Closed',text:'Market is closed now',confirmButtonColor:'#fbbf24'});
                    else if(d.status==='error_min') Swal.fire({icon:'error',title:'Limit',text:'Min bet is 50 Ks',confirmButtonColor:'#d33'});
                    else if(d.status==='error_max') Swal.fire({icon:'error',title:'Limit',text:'Max bet is 100,000 Ks',confirmButtonColor:'#d33'});
                    else Swal.fire('Error','Invalid Bet','error'); 
                } catch(e){
                    // ERROR STOP
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                    Toast.fire({icon:'error',title:'Connection Failed'});
                } 
            }
            
            function showVoucher(v){ 
                document.getElementById('voucherContent').innerHTML=\`<div class="text-center border-b-2 border-dashed border-gray-200 pb-4 mb-4"><h2 class="text-2xl font-black text-slate-800 mb-1 tracking-tighter">MYANMAR 2D</h2><p class="text-xs text-gray-400 font-mono">ID: \${v.id}</p><div class="flex justify-between mt-4 text-sm"><span class="text-gray-500">User:</span> <span class="font-bold">\${v.user}</span></div><div class="flex justify-between text-sm"><span class="text-gray-500">Time:</span> <span class="font-bold">\${v.date} \${v.time}</span></div></div><div class="max-h-40 overflow-y-auto font-mono text-sm mb-4 bg-gray-50 p-2 rounded-lg">\${v.numbers.map(n=>\`<div class="flex justify-between mb-1"><span>\${n}</span><span>\${v.amountPerNum}</span></div>\`).join('')}</div><div class="flex justify-between font-black text-xl border-t-2 border-dashed border-gray-200 pt-4 text-slate-900"><span>TOTAL</span><span>\${v.total.toLocaleString()} Ks</span></div><div class="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 border-4 border-green-500/20 text-green-500/20 font-black text-5xl rotate-[-15deg] p-4 rounded-xl select-none pointer-events-none">PAID</div>\`; 
                document.getElementById('voucherModal').classList.remove('hidden'); 
            }
            
            function filterHistory(){ const f=document.getElementById('historySearch').value.trim(); const l=document.getElementById('historyList').getElementsByClassName('history-item'); for(let x of l){ const t=x.querySelector('.bet-number').innerText; x.style.display = t.includes(f)?'flex':'none'; } }
        </script>
      `;
  }

  return new Response(`<!DOCTYPE html><html lang="en"><head><title>Myanmar 2D</title>${commonHead}</head><body class="max-w-md mx-auto min-h-screen bg-slate-900 text-white pb-20">${loaderHTML}${splashHTML}${content}${navHTML}
  <script>const API_URL="https://api.thaistock2d.com/live"; async function updateData(){try{const res=await fetch(API_URL);const data=await res.json();
  const now=new Date(); const mmDate=new Date(now.toLocaleString("en-US",{timeZone:"Asia/Yangon"})); const todayStr=mmDate.getFullYear()+"-"+String(mmDate.getMonth()+1).padStart(2,'0')+"-"+String(mmDate.getDate()).padStart(2,'0'); const day=mmDate.getDay(); const isWk=(day===0||day===6); const isSame=data.live&&data.live.date===todayStr;
  if(data.live){ document.getElementById('live_twod').innerText=(isSame&&!isWk)?(data.live.twod||"--"):"--"; document.getElementById('live_time').innerText=(isSame&&!isWk)?(data.live.time||"--:--:--"):"--:--:--"; }
  if(data.result){ const m=document.getElementById('set_12'); if(m){ if(isSame&&!isWk){ if(data.result[1]){document.getElementById('set_12').innerText=data.result[1].set||"--";document.getElementById('val_12').innerText=data.result[1].value||"--";document.getElementById('res_12').innerText=data.result[1].twod||"--";} const ev=data.result[3]||data.result[2]; if(ev){document.getElementById('set_430').innerText=ev.set||"--";document.getElementById('val_430').innerText=ev.value||"--";document.getElementById('res_430').innerText=ev.twod||"--";} } else { document.getElementById('set_12').innerText="--";document.getElementById('val_12').innerText="--";document.getElementById('res_12').innerText="--"; document.getElementById('set_430').innerText="--";document.getElementById('val_430').innerText="--";document.getElementById('res_430').innerText="--"; } } } }catch(e){}} setInterval(updateData,2000); updateData();</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
});
