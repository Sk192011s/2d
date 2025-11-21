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
        if (data.result[1] && data.result[1].twod) morning = data.result[1].twod;
        const ev = data.result[3] || data.result[2];
        if (ev && ev.twod) evening = ev.twod;
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

  // EMERGENCY ADMIN RESET
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

  // =========================
  // ACTIONS
  // =========================
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

    return new Response(JSON.stringify({ 
        status: "success",
        voucher: { user: currentUser, date: dateString, time: timeString, numbers: numberList, amountPerNum: amount, total: totalCost, id: Date.now().toString().slice(-6) }
    }), { headers: { "content-type": "application/json" } });
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
        const contactData = {
            kpay_name: form.get("kpay_name") || "Admin", kpay_no: form.get("kpay_no") || "09-", kpay_img: form.get("kpay_img") || "",
            wave_name: form.get("wave_name") || "Admin", wave_no: form.get("wave_no") || "09-", wave_img: form.get("wave_img") || "",
            tele_link: form.get("tele_link") || "#"
        };
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
        if (action === "clear") {
            const iter = kv.list({ prefix: ["blocks"] });
            for await (const entry of iter) await kv.delete(entry.key);
        } else if (action === "unblock" && val) {
            await kv.delete(["blocks", val]);
        } else if (action === "add" && val) {
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
        @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap');
        body { font-family: 'Roboto', sans-serif; background-color: #111827; color: white; -webkit-tap-highlight-color: transparent; padding-bottom: 80px; }
        .bg-card { background-color: #1f2937; }
        .text-gold { color: #fbbf24; }
        
        /* Premium Gradient */
        .bg-premium { background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); }
        .btn-gold { background: linear-gradient(45deg, #f59e0b, #d97706); color: white; }
        
        /* Bottom Nav */
        .bottom-nav { position: fixed; bottom: 0; left: 0; width: 100%; background: #1f2937; border-top: 1px solid #374151; display: flex; justify-content: space-around; padding: 10px 0; z-index: 50; }
        .nav-item { display: flex; flex-direction: column; align-items: center; color: #9ca3af; font-size: 10px; }
        .nav-item.active { color: #fbbf24; }
        .nav-item i { font-size: 20px; margin-bottom: 2px; }

        /* Loader */
        #app-loader { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); z-index: 9999; display: flex; justify-content: center; align-items: center; transition: opacity 0.3s ease; }
        .spinner { width: 50px; height: 50px; border: 4px solid #fbbf24; border-bottom-color: transparent; border-radius: 50%; animation: rotation 1s linear infinite; }
        @keyframes rotation { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .hidden-loader { opacity: 0; pointer-events: none; display: none !important; }

        /* Toast Custom */
        .swal2-popup.swal2-toast { background: #1f2937 !important; color: white !important; }
    </style>
    <script>
        const Toast = Swal.mixin({ toast: true, position: 'top', showConfirmButton: false, timer: 3000, timerProgressBar: true });
        window.addEventListener('pageshow', () => { document.getElementById('app-loader').classList.add('hidden-loader'); });
        window.addEventListener('load', () => { 
             document.getElementById('app-loader').classList.add('hidden-loader');
             if(!sessionStorage.getItem('splash')){ 
                 document.getElementById('splash').style.display='flex';
                 setTimeout(()=>{ document.getElementById('splash').style.opacity='0'; setTimeout(()=>document.getElementById('splash').style.display='none',500); sessionStorage.setItem('splash','1'); }, 2000);
             } else { document.getElementById('splash').style.display='none'; }
        });
        function showLoader(){ document.getElementById('app-loader').classList.remove('hidden-loader'); }
    </script>
  `;
  
  const loaderHTML = `<div id="app-loader"><div class="spinner"></div></div>`;
  const splashHTML = `<div id="splash" style="position:fixed;inset:0;background:#111;z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;transition:opacity 0.5s;"><img src="https://img.icons8.com/color/144/shop.png" class="w-24 mb-4 animate-bounce"><h1 class="text-2xl font-bold text-gold tracking-widest">MYANMAR 2D</h1></div>`;

  // LOGIN PAGE
  if (!currentUser) {
    return new Response(`<!DOCTYPE html><html><head><title>Welcome</title>${commonHead}</head><body class="h-screen flex items-center justify-center px-4">${splashHTML}${loaderHTML}<div class="bg-card w-full max-w-sm p-6 rounded-2xl shadow-2xl border border-gray-700 text-center"><img src="https://img.icons8.com/color/96/shop.png" class="w-20 mx-auto mb-4"><h1 class="text-2xl font-bold text-white mb-6">Myanmar 2D Live</h1><div class="flex justify-center mb-6 border-b border-gray-700"><button onclick="showLogin()" id="tabLogin" class="w-1/2 pb-2 border-b-2 border-yellow-500 text-yellow-500 font-bold">Login</button><button onclick="showRegister()" id="tabReg" class="w-1/2 pb-2 text-gray-400">Register</button></div><form id="loginForm" action="/login" method="POST" onsubmit="showLoader()"><input name="username" placeholder="Username" class="w-full bg-gray-700 text-white p-3 rounded mb-3" required><input type="password" name="password" placeholder="Password" class="w-full bg-gray-700 text-white p-3 rounded mb-4" required><label class="flex items-center gap-2 text-xs text-gray-400 mb-4"><input type="checkbox" name="remember" checked> Remember Me (15 Days)</label><button class="w-full btn-gold py-3 rounded font-bold">LOGIN</button></form><form id="regForm" action="/register" method="POST" class="hidden" onsubmit="showLoader()"><input name="username" placeholder="New Username" class="w-full bg-gray-700 text-white p-3 rounded mb-3" required><input type="password" name="password" placeholder="New Password" class="w-full bg-gray-700 text-white p-3 rounded mb-4" required><label class="flex items-center gap-2 text-xs text-gray-400 mb-4"><input type="checkbox" name="remember" checked> Remember Me (15 Days)</label><button class="w-full btn-gold py-3 rounded font-bold">CREATE ACCOUNT</button></form></div><script>const p=new URLSearchParams(window.location.search);if(p.get('error'))Toast.fire({icon:'error',title:p.get('error')});function showLogin(){document.getElementById('loginForm').classList.remove('hidden');document.getElementById('regForm').classList.add('hidden');document.getElementById('tabLogin').classList.add('border-yellow-500','text-yellow-500');document.getElementById('tabLogin').classList.remove('text-gray-400');document.getElementById('tabReg').classList.remove('border-yellow-500','text-yellow-500');document.getElementById('tabReg').classList.add('text-gray-400');}function showRegister(){document.getElementById('loginForm').classList.add('hidden');document.getElementById('regForm').classList.remove('hidden');document.getElementById('tabReg').classList.add('border-yellow-500','text-yellow-500');document.getElementById('tabReg').classList.remove('text-gray-400');document.getElementById('tabLogin').classList.remove('border-yellow-500','text-yellow-500');document.getElementById('tabLogin').classList.add('text-gray-400');}</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const userEntry = await kv.get(["users", currentUser]);
  const userData = userEntry.value as any;
  const balance = userData?.balance || 0;
  const avatar = userData?.avatar || "";

  // PAGE ROUTING
  const page = url.pathname;
  let content = "";
  
  // --- HISTORY PAGE ---
  if (page === "/history") {
      const historyList = [];
      const hIter = kv.list({ prefix: ["history"] }, { reverse: true });
      for await (const entry of hIter) historyList.push(entry.value);
      content = `
        <div class="p-4"><h2 class="text-xl font-bold text-gold mb-4">2D History</h2>
        <div class="bg-card rounded-xl overflow-hidden border border-gray-700">
            <div class="grid grid-cols-3 bg-gray-800 p-3 text-xs font-bold text-gray-400 text-center"><div>DATE</div><div>12:01 PM</div><div>04:30 PM</div></div>
            ${historyList.map((h: any) => `<div class="grid grid-cols-3 p-3 text-center border-t border-gray-700 items-center"><div class="text-xs text-gray-300">${h.date}</div><div class="font-bold text-blue-400">${h.morning}</div><div class="font-bold text-purple-400">${h.evening}</div></div>`).join('')}
            ${historyList.length===0?'<div class="p-4 text-center text-gray-500 text-sm">No history available</div>':''}
        </div></div>`;
  }
  // --- PROFILE PAGE ---
  else if (page === "/profile") {
      const transactions = [];
      const txIter = kv.list({ prefix: ["transactions"] }, { reverse: true, limit: 50 });
      for await (const entry of txIter) { if (entry.value.user === currentUser) transactions.push(entry.value); }
      const contactEntry = await kv.get(["system", "contact"]);
      const contact = contactEntry.value as any || { kpay_no: "", kpay_name: "", wave_no: "", wave_name: "", tele_link: "" };
      
      // Stats (Admin only)
      let adminStats = "";
      if (isAdmin) {
          const todayStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });
          let sale=0, payout=0;
          for await (const entry of kv.list({ prefix: ["bets"] })) {
             const b = entry.value as any;
             const d = new Date(parseInt(entry.key[1])).toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });
             if(d===todayStr) { sale+=b.amount; if(b.status==="WIN") payout+=(b.winAmount||0); }
          }
          adminStats = `<div class="grid grid-cols-3 gap-2 mb-4"><div class="bg-green-900/30 p-2 rounded text-center border border-green-500/30"><div class="text-[10px] text-green-400">SALE</div><div class="font-bold">${sale.toLocaleString()}</div></div><div class="bg-red-900/30 p-2 rounded text-center border border-red-500/30"><div class="text-[10px] text-red-400">PAYOUT</div><div class="font-bold">${payout.toLocaleString()}</div></div><div class="bg-blue-900/30 p-2 rounded text-center border border-blue-500/30"><div class="text-[10px] text-blue-400">PROFIT</div><div class="font-bold">${(sale-payout).toLocaleString()}</div></div></div>`;
      }

      content = `
        <div class="bg-card p-6 rounded-b-3xl shadow-lg text-center relative mb-4">
            <div class="relative w-20 h-20 mx-auto mb-2">
                <div class="w-20 h-20 rounded-full bg-gray-700 overflow-hidden border-2 border-gold flex items-center justify-center">${avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : `<i class="fas fa-user text-3xl text-gray-400"></i>`}</div>
                <button onclick="document.getElementById('pInput').click()" class="absolute bottom-0 right-0 bg-gold text-black rounded-full p-1.5 shadow-lg"><i class="fas fa-camera text-xs"></i></button>
                <input type="file" id="pInput" hidden accept="image/*" onchange="uploadAvatar(this)">
            </div>
            <h1 class="text-lg font-bold text-white uppercase">${currentUser}</h1>
            <p class="text-gold text-sm font-bold">${balance.toLocaleString()} Ks</p>
        </div>
        <div class="px-4 space-y-4">
            ${adminStats}
            ${isAdmin ? `
            <div class="bg-card p-4 rounded-xl border border-gray-700">
                <h3 class="text-sm font-bold text-gray-400 mb-2">Admin Tools</h3>
                <form action="/admin/topup" method="POST" onsubmit="showLoader()" class="flex gap-2 mb-2"><input name="username" placeholder="User" class="w-1/3 bg-gray-800 rounded p-2 text-xs"><input name="amount" placeholder="Amt" type="number" class="w-1/3 bg-gray-800 rounded p-2 text-xs"><button class="bg-green-600 text-white w-1/3 rounded text-xs font-bold">Topup</button></form>
                <form action="/admin/payout" method="POST" onsubmit="showLoader()" class="flex gap-2 mb-2"><select name="session" class="w-1/3 bg-gray-800 rounded p-2 text-xs"><option value="MORNING">12:01</option><option value="EVENING">04:30</option></select><input name="win_number" placeholder="Win No" class="w-1/3 bg-gray-800 rounded p-2 text-center text-xs"><button class="bg-red-600 text-white w-1/3 rounded text-xs font-bold">Payout</button></form>
                <form action="/admin/contact" method="POST" onsubmit="showLoader()" class="grid grid-cols-2 gap-2 mb-2"><input name="kpay_no" placeholder="KPay No" class="bg-gray-800 rounded p-2 text-xs"><input name="wave_no" placeholder="Wave No" class="bg-gray-800 rounded p-2 text-xs"><button class="col-span-2 bg-blue-600 rounded py-2 text-xs font-bold">Update Contact</button></form>
                <form action="/admin/tip" method="POST" onsubmit="showLoader()" class="flex gap-2"><input name="tip" placeholder="Lucky Tip" class="flex-1 bg-gray-800 rounded p-2 text-xs"><button class="bg-purple-600 text-white px-3 rounded text-xs font-bold">Tip</button></form>
                <form action="/admin/add_history" method="POST" onsubmit="showLoader()" class="flex gap-2 mt-2"><input name="date" type="date" class="w-1/3 bg-gray-800 rounded p-2 text-xs"><input name="morning" placeholder="M" class="w-1/4 bg-gray-800 rounded p-2 text-center text-xs"><input name="evening" placeholder="E" class="w-1/4 bg-gray-800 rounded p-2 text-center text-xs"><button class="bg-gray-600 text-white w-1/6 rounded text-xs">Save</button></form>
            </div>` : ''}

            <div class="bg-card p-4 rounded-xl border border-gray-700">
                <h3 class="text-sm font-bold text-gray-400 mb-3">Change Password</h3>
                <form action="/change_password" method="POST" onsubmit="showLoader()" class="flex gap-2"><input type="password" name="new_password" placeholder="New Password" class="flex-1 bg-gray-800 rounded p-2 text-sm" required><button class="bg-gold text-black px-4 py-2 rounded text-sm font-bold">Change</button></form>
            </div>

            <div class="bg-card p-4 rounded-xl border border-gray-700">
                <h3 class="text-sm font-bold text-gray-400 mb-3">Contact Admin</h3>
                <div class="grid grid-cols-2 gap-2">
                    <div class="bg-blue-900/20 border border-blue-500/30 p-3 rounded text-center"><div class="text-xs text-blue-400 font-bold">KPay</div><div class="text-sm font-bold select-all">${contact.kpay_no}</div></div>
                    <div class="bg-yellow-900/20 border border-yellow-500/30 p-3 rounded text-center"><div class="text-xs text-yellow-400 font-bold">Wave</div><div class="text-sm font-bold select-all">${contact.wave_no}</div></div>
                    <a href="${contact.tele_link}" target="_blank" class="col-span-2 bg-blue-600 text-white p-2 rounded text-center font-bold text-sm"><i class="fab fa-telegram"></i> Telegram</a>
                </div>
            </div>

            <div class="bg-card p-4 rounded-xl border border-gray-700">
                <h3 class="text-sm font-bold text-gray-400 mb-3">Transactions</h3>
                <div class="space-y-2 h-40 overflow-y-auto history-scroll">
                    ${transactions.length === 0 ? '<div class="text-center text-gray-500 text-xs">No transactions</div>' : ''}
                    ${transactions.map(tx => `<div class="flex justify-between items-center p-2 bg-gray-800 rounded border-l-2 ${tx.type==='TOPUP'?'border-green-500':'border-red-500'}"><div class="text-xs text-gray-300">${tx.time}</div><div class="font-bold text-sm text-white">+${tx.amount.toLocaleString()}</div></div>`).join('')}
                </div>
            </div>
        </div>
        <script>function uploadAvatar(input) { if(input.files && input.files[0]) { const file = input.files[0]; const reader = new FileReader(); reader.onload = function(e) { const img = new Image(); img.src = e.target.result; img.onload = function() { const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d'); const size = 150; canvas.width = size; canvas.height = size; let sSize = Math.min(img.width, img.height); let sx = (img.width - sSize) / 2; let sy = (img.height - sSize) / 2; ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, size, size); const dataUrl = canvas.toDataURL('image/jpeg', 0.7); const fd = new FormData(); fd.append('avatar', dataUrl); showLoader(); fetch('/update_avatar', { method: 'POST', body: fd }).then(res => res.json()).then(d => { hideLoader(); if(d.status==='success') location.reload(); else Toast.fire({icon:'error',title:'Upload failed'}); }); } }; reader.readAsDataURL(file); } } </script>
      `;
  }
  // --- HOME PAGE ---
  else {
      const bets = [];
      const iter = kv.list({ prefix: ["bets"] }, { reverse: true, limit: 50 });
      for await (const entry of iter) { if (isAdmin || entry.value.user === currentUser) bets.push(entry.value); }
      const tipEntry = await kv.get(["system", "tip"]);
      const dailyTip = tipEntry.value || "";

      content = `
        <div class="p-4 pt-6">
            <div class="card-gradient rounded-2xl p-6 text-center shadow-lg relative overflow-hidden mb-4 border border-white/10">
              <div class="flex justify-between items-center mb-2 text-gray-300 text-xs font-bold uppercase"><span id="live_date">Today</span><span class="flex items-center gap-1 text-green-400"><i class="fas fa-circle text-[8px]"></i> Live</span></div>
              <div class="py-2"><div id="live_twod" class="text-7xl font-bold tracking-widest text-white drop-shadow-lg">--</div><div class="text-xs mt-2 text-gray-400">Update: <span id="live_time">--:--:--</span></div></div>
            </div>

            ${dailyTip ? `<div class="mb-4 relative overflow-hidden rounded-xl shadow-lg"><div class="absolute inset-0 bg-gradient-to-r from-cyan-500 to-blue-500 animate-gradient-x"></div><div class="relative bg-gray-900/90 m-[1px] rounded-xl p-3 text-center"><span class="bg-blue-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase">VIP TIP</span><p class="text-lg font-bold text-white mt-1">${dailyTip}</p></div></div>` : ''}

            ${!isAdmin ? `<button onclick="openBetModal()" class="w-full btn-gold py-3 rounded-xl font-bold text-lg shadow-lg mb-6 active:scale-95 transition"><i class="fas fa-plus-circle"></i> ထိုးမည် (Bet)</button>` : ''}

            <div class="grid grid-cols-1 gap-3 mb-6">
                <div class="bg-card p-3 rounded-xl border border-gray-700 flex justify-between items-center"><div><div class="text-xs text-gray-400 font-bold">12:01 PM</div><div id="set_12" class="text-[10px] text-gray-500">SET: --</div></div><div id="res_12" class="text-3xl font-bold text-gold">--</div></div>
                <div class="bg-card p-3 rounded-xl border border-gray-700 flex justify-between items-center"><div><div class="text-xs text-gray-400 font-bold">04:30 PM</div><div id="set_430" class="text-[10px] text-gray-500">SET: --</div></div><div id="res_430" class="text-3xl font-bold text-gold">--</div></div>
            </div>

            <div class="flex justify-between items-center mb-2"><h3 class="font-bold text-gray-400 text-xs uppercase">Recent Bets</h3><div class="relative"><input type="text" id="historySearch" onkeyup="filterHistory()" placeholder="Search" class="bg-gray-800 border border-gray-700 rounded-full px-3 py-1 text-xs text-white w-24 text-center"></div></div>
            <div id="historyList" class="space-y-2 h-64 overflow-y-auto history-scroll pb-20">
                ${bets.map(b => `<div class="history-item bg-gray-800 p-3 rounded-lg border-l-2 ${b.status==='WIN'?'border-green-500':b.status==='LOSE'?'border-red-500':'border-yellow-500'} flex justify-between items-center"><div class="text-white font-bold text-lg bet-number">${b.number}</div><div class="text-right"><div class="text-gold font-bold text-sm">${b.amount}</div><div class="text-[10px] text-gray-400">${b.status}</div></div></div>`).join('')}
                ${bets.length===0?'<div class="text-center text-gray-600 text-xs mt-10">No bets placed yet</div>':''}
            </div>
        </div>
        
        <div id="betModal" class="fixed inset-0 bg-black/90 hidden z-50 flex items-end justify-center"><div class="bg-gray-800 w-full rounded-t-2xl p-5 border-t border-gray-700"><div class="flex justify-between items-center mb-4"><h2 class="text-lg font-bold text-white">Place Bet</h2><button onclick="closeBetModal()" class="text-gray-400"><i class="fas fa-times"></i></button></div>
        <div class="flex gap-2 mb-4"><button onclick="setTab('direct')" id="btnDirect" class="flex-1 py-2 rounded bg-gold text-black font-bold text-xs">Direct</button><button onclick="setTab('quick')" id="btnQuick" class="flex-1 py-2 rounded bg-gray-700 text-gray-300 font-bold text-xs">Quick</button></div>
        <form id="betForm" onsubmit="placeBet(event)"><div id="tabDirectContent"><textarea id="numberInput" name="number" class="w-full h-20 bg-gray-900 border border-gray-600 rounded p-3 text-white text-lg focus:border-gold outline-none" placeholder="12, 34, 56"></textarea></div><div id="tabQuickContent" class="hidden grid grid-cols-4 gap-2 mb-2"><button type="button" onclick="quickBet('head')" class="bg-gray-700 text-white p-2 rounded text-xs">Head</button><button type="button" onclick="quickBet('tail')" class="bg-gray-700 text-white p-2 rounded text-xs">Tail</button><button type="button" onclick="quickBet('double')" class="bg-gray-700 text-white p-2 rounded text-xs">Double</button><button type="button" onclick="quickBet('brake')" class="bg-gray-700 text-white p-2 rounded text-xs">Brake</button><div id="quickInputArea" class="col-span-4 hidden flex gap-2 mt-2"><input type="number" id="quickVal" class="flex-1 bg-gray-900 border border-gray-600 rounded p-2 text-white"><button type="button" onclick="generateNumbers()" class="bg-gold text-black px-4 rounded font-bold">Add</button></div></div><div class="mt-4"><input type="number" name="amount" class="w-full bg-gray-900 border border-gray-600 rounded p-3 text-white text-center text-lg mb-3" placeholder="Amount (Ks)" required><button class="w-full btn-gold py-3 rounded font-bold text-lg">CONFIRM</button></div></form></div></div>
        
        <div id="voucherModal" class="fixed inset-0 bg-black/95 hidden z-[60] flex items-center justify-center p-5"><div class="bg-white w-full max-w-sm rounded-xl overflow-hidden relative"><button onclick="closeVoucher()" class="absolute top-2 right-3 text-gray-500 text-2xl">&times;</button><div id="voucherContent" class="p-5 text-gray-800"></div><div class="bg-gray-100 p-3"><button onclick="closeVoucher()" class="bg-gray-800 text-white w-full py-3 rounded font-bold">Close</button></div></div></div>
        
        <script>
            const p = new URLSearchParams(window.location.search);
            if(p.get('status')==='pass_changed') Toast.fire({icon:'success',title:'Password Updated'});
            
            // TABS
            function setTab(t) { const d=document.getElementById('tabDirectContent'), q=document.getElementById('tabQuickContent'), bd=document.getElementById('btnDirect'), bq=document.getElementById('btnQuick'); if(t==='direct'){d.classList.remove('hidden');q.classList.add('hidden');bd.className="flex-1 py-2 rounded bg-gold text-black font-bold text-xs";bq.className="flex-1 py-2 rounded bg-gray-700 text-gray-300 font-bold text-xs";}else{d.classList.add('hidden');q.classList.remove('hidden');bd.className="flex-1 py-2 rounded bg-gray-700 text-gray-300 font-bold text-xs";bq.className="flex-1 py-2 rounded bg-gold text-black font-bold text-xs";} }
            
            // BETTING & MODALS
            function openBetModal(){ document.getElementById('betModal').classList.remove('hidden'); }
            function closeBetModal(){ document.getElementById('betModal').classList.add('hidden'); }
            function closeVoucher(){ document.getElementById('voucherModal').classList.add('hidden'); window.location.reload(); }
            
            // QUICK BET
            let qMode=''; function quickBet(m){ const a=document.getElementById('quickInputArea'); if(m==='double'){addNums(genDouble());a.classList.add('hidden');}else{qMode=m;a.classList.remove('hidden');document.getElementById('quickVal').focus();} }
            function generateNumbers(){ const v=document.getElementById('quickVal').value; if(!v)return; let n=[]; if(qMode==='head')n=genHead(v); if(qMode==='tail')n=genTail(v); if(qMode==='brake')n=genBrake(v); addNums(n); document.getElementById('quickVal').value=''; }
            function addNums(n){ const i=document.getElementById('numberInput'); let c=i.value.trim(); if(c&&!c.endsWith(','))c+=','; i.value=c+n.join(','); }
            function genHead(d){let r=[];for(let i=0;i<10;i++)r.push(d+i);return r;} function genTail(d){let r=[];for(let i=0;i<10;i++)r.push(i+d);return r;} function genDouble(){let r=[];for(let i=0;i<10;i++)r.push(i+""+i);return r;} function genBrake(n){if(n.length!==2)return[];const r=n[1]+n[0];return n===r?[n]:[n,r];}
            
            // AJAX BET
            async function placeBet(e){ e.preventDefault(); showLoader(); const fd=new FormData(e.target); try{ const res=await fetch('/bet',{method:'POST',body:fd}); const d=await res.json(); hideLoader();
            if(d.status==='success'){ closeBetModal(); showVoucher(d.voucher); Toast.fire({icon:'success',title:'Bet Placed!'}); }
            else if(d.status==='blocked') Swal.fire('Blocked','Number '+d.num+' is closed','error');
            else if(d.status==='insufficient_balance') Swal.fire('Error','Insufficient Balance','error');
            else if(d.status==='market_closed') Swal.fire('Closed','Market Closed','warning');
            else Swal.fire('Error','Invalid Bet','error'); } catch(e){hideLoader();} }
            
            function showVoucher(v){ 
                document.getElementById('voucherContent').innerHTML=\`<div class="text-center border-b-2 border-dashed border-gray-300 pb-4 mb-4"><h2 class="text-2xl font-bold mb-1">MYANMAR 2D</h2><p class="text-xs text-gray-500">ID: \${v.id}</p><p class="text-sm mt-1">User: <b>\${v.user}</b></p><p class="text-xs text-gray-400">\${v.date} \${v.time}</p></div><div class="max-h-40 overflow-y-auto font-mono text-sm mb-4">\${v.numbers.map(n=>\`<div class="flex justify-between mb-1"><span>\${n}</span><span>\${v.amountPerNum}</span></div>\`).join('')}</div><div class="flex justify-between font-bold text-lg border-t-2 border-dashed border-gray-300 pt-2"><span>TOTAL</span><span>\${v.total.toLocaleString()} Ks</span></div><div class="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 border-4 border-gray-200 text-gray-200 font-bold text-4xl rotate-[-15deg] p-2 rounded select-none pointer-events-none">PAID</div>\`; 
                document.getElementById('voucherModal').classList.remove('hidden'); 
            }
            
            function filterHistory(){ const f=document.getElementById('historySearch').value.trim(); const l=document.getElementById('historyList').getElementsByClassName('history-item'); for(let x of l){ const t=x.querySelector('.bet-number').innerText; x.style.display = t.includes(f)?'flex':'none'; } }
        </script>
      `;
  }

  // BOTTOM NAV
  const activeClass = (p: string) => page === p ? "text-gold" : "text-gray-500";
  const navHTML = `
    <div class="bottom-nav">
        <a href="/" class="nav-item ${activeClass('/')}"><i class="fas fa-home"></i><span>Home</span></a>
        <a href="/history" class="nav-item ${activeClass('/history')}"><i class="fas fa-clock"></i><span>History</span></a>
        <a href="/profile" class="nav-item ${activeClass('/profile')}"><i class="fas fa-user"></i><span>Profile</span></a>
    </div>
  `;

  return new Response(`<!DOCTYPE html><html lang="en"><head><title>Myanmar 2D</title>${commonHead}</head><body class="max-w-md mx-auto min-h-screen bg-gray-900 text-white pb-20">${loaderHTML}${splashHTML}${content}${navHTML}
  <script>const API_URL="https://api.thaistock2d.com/live"; async function updateData(){try{const res=await fetch(API_URL);const data=await res.json();
  const now=new Date(); const mmDate=new Date(now.toLocaleString("en-US",{timeZone:"Asia/Yangon"})); const todayStr=mmDate.getFullYear()+"-"+String(mmDate.getMonth()+1).padStart(2,'0')+"-"+String(mmDate.getDate()).padStart(2,'0'); const day=mmDate.getDay(); const isWk=(day===0||day===6); const isSame=data.live&&data.live.date===todayStr;
  if(data.live){ document.getElementById('live_twod').innerText=(isSame&&!isWk)?(data.live.twod||"--"):"--"; document.getElementById('live_time').innerText=(isSame&&!isWk)?(data.live.time||"--:--:--"):"--:--:--"; }
  if(data.result){ const m=document.getElementById('set_12'); if(m){ if(isSame&&!isWk){ if(data.result[1]){document.getElementById('set_12').innerText=data.result[1].set||"--";document.getElementById('val_12').innerText=data.result[1].value||"--";document.getElementById('res_12').innerText=data.result[1].twod||"--";} const ev=data.result[3]||data.result[2]; if(ev){document.getElementById('set_430').innerText=ev.set||"--";document.getElementById('val_430').innerText=ev.value||"--";document.getElementById('res_430').innerText=ev.twod||"--";} } else { document.getElementById('set_12').innerText="--";document.getElementById('val_12').innerText="--";document.getElementById('res_12').innerText="--"; document.getElementById('set_430').innerText="--";document.getElementById('val_430').innerText="--";document.getElementById('res_430').innerText="--"; } } } }catch(e){}} setInterval(updateData,2000); updateData();</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
});
