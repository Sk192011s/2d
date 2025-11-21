import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const kv = await Deno.openKv();

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
  
  // =========================
  // 1. AUTH (FIXED FOR MYANMAR FONT)
  // =========================
  const cookieOptions = "; Path=/; HttpOnly; Max-Age=1296000"; 

  if (req.method === "POST" && url.pathname === "/register") {
    const form = await req.formData();
    const username = form.get("username")?.toString().trim(); // Removed toLowerCase for Myanmar names
    const password = form.get("password")?.toString();

    if (!username || !password) return Response.redirect(url.origin + "/?error=missing_fields");

    const userEntry = await kv.get(["users", username]);
    if (userEntry.value) return Response.redirect(url.origin + "/?error=user_exists");

    await kv.set(["users", username], { password, balance: 0 });
    
    const headers = new Headers({ "Location": "/" });
    // FIX: Encode URI Component for Myanmar Characters
    headers.set("Set-Cookie", `user=${encodeURIComponent(username)}${cookieOptions}`);
    return new Response(null, { status: 303, headers });
  }

  if (req.method === "POST" && url.pathname === "/login") {
    const form = await req.formData();
    const username = form.get("username")?.toString().trim();
    const password = form.get("password")?.toString();

    const userEntry = await kv.get(["users", username]);
    const userData = userEntry.value as any;

    if (!userData || userData.password !== password) {
       return Response.redirect(url.origin + "/?error=invalid_login");
    }

    const headers = new Headers({ "Location": "/" });
    // FIX: Encode URI Component
    headers.set("Set-Cookie", `user=${encodeURIComponent(username)}${cookieOptions}`);
    return new Response(null, { status: 303, headers });
  }

  if (url.pathname === "/logout") {
    const headers = new Headers({ "Location": "/" });
    headers.set("Set-Cookie", `user=; Path=/; Max-Age=0`);
    return new Response(null, { status: 303, headers });
  }

  const cookies = req.headers.get("Cookie") || "";
  const userCookie = cookies.split(";").find(c => c.trim().startsWith("user="));
  // FIX: Decode URI Component to read Myanmar names
  const currentUser = userCookie ? decodeURIComponent(userCookie.split("=")[1].trim()) : null;
  const isAdmin = currentUser === "admin";

  // =========================
  // 2. PROFILE & ACTIONS
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
      if (newPass) {
          const userEntry = await kv.get(["users", currentUser]);
          const userData = userEntry.value as any;
          await kv.set(["users", currentUser], { ...userData, password: newPass });
          return Response.redirect(url.origin + "/profile?status=pass_changed");
      }
      return Response.redirect(url.origin + "/profile?status=error");
  }

  // =========================
  // 3. BETTING LOGIC
  // =========================
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

  // =========================
  // 4. ADMIN LOGIC
  // =========================
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
      return new Response(null, { status: 303, headers: { "Location": "/" } });
    }
    
    if (url.pathname === "/admin/reset_pass") {
        const form = await req.formData();
        const targetUser = form.get("username")?.toString().trim();
        const newPass = form.get("password")?.toString();
        if (targetUser && newPass) {
            const userEntry = await kv.get(["users", targetUser]);
            const userData = userEntry.value as any;
            if (userData) await kv.set(["users", targetUser], { ...userData, password: newPass });
        }
        return new Response(null, { status: 303, headers: { "Location": "/" } });
    }

    if (url.pathname === "/admin/contact") {
        const form = await req.formData();
        const contactData = {
            kpay_name: form.get("kpay_name") || "Admin", kpay_no: form.get("kpay_no") || "09-", kpay_img: form.get("kpay_img") || "",
            wave_name: form.get("wave_name") || "Admin", wave_no: form.get("wave_no") || "09-", wave_img: form.get("wave_img") || "",
            tele_link: form.get("tele_link") || "#"
        };
        await kv.set(["system", "contact"], contactData);
        return new Response(null, { status: 303, headers: { "Location": "/" } });
    }

    if (url.pathname === "/admin/rate") {
        const form = await req.formData();
        const rate = parseInt(form.get("rate")?.toString() || "80");
        await kv.set(["system", "rate"], rate);
        return new Response(null, { status: 303, headers: { "Location": "/" } });
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
      return new Response(null, { status: 303, headers: { "Location": "/" } });
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

            for (const n of numsToBlock) {
                if(n.length === 2) await kv.set(["blocks", n], true);
            }
        }
        return new Response(null, { status: 303, headers: { "Location": "/" } });
    }

    if (url.pathname === "/admin/tip") {
        const form = await req.formData();
        const tip = form.get("tip")?.toString();
        await kv.set(["system", "tip"], tip);
        return new Response(null, { status: 303, headers: { "Location": "/" } });
    }
    
    if (url.pathname === "/admin/add_history") {
      const form = await req.formData();
      const date = form.get("date")?.toString(); 
      const morning = form.get("morning")?.toString() || "--";
      const evening = form.get("evening")?.toString() || "--";
      if (date) await kv.set(["history", date], { morning, evening, date });
      return new Response(null, { status: 303, headers: { "Location": "/" } });
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
        body { font-family: 'Roboto', sans-serif; background-color: #4a3b32; color: white; -webkit-tap-highlight-color: transparent; }
        .bg-theme { background-color: #4a3b32; }
        .text-theme { color: #4a3b32; }
        .card-gradient { background: linear-gradient(135deg, #5d4037 0%, #3e2723 100%); }
        .tab-active { background-color: #4a3b32; color: white; }
        .tab-inactive { background-color: #eee; color: #666; }
        #app-loader { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 9999; display: flex; justify-content: center; align-items: center; transition: opacity 0.3s ease; }
        .spinner { width: 50px; height: 50px; border: 5px solid #fff; border-bottom-color: transparent; border-radius: 50%; animation: rotation 1s linear infinite; }
        @keyframes rotation { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .hidden-loader { opacity: 0; pointer-events: none; }
        #splash-screen { position: fixed; inset: 0; background-color: #4a3b32; z-index: 10000; display: flex; flex-direction: column; align-items: center; justify-content: center; transition: opacity 0.7s ease-out; }
        .splash-logo { width: 100px; height: 100px; margin-bottom: 20px; animation: bounce 2s infinite; }
        @keyframes bounce { 0%, 100% { transform: translateY(-10%); } 50% { transform: translateY(0); } }
        .loading-bar { width: 150px; height: 4px; background: rgba(255,255,255,0.2); border-radius: 2px; overflow: hidden; }
        .loading-progress { height: 100%; background: #fbbf24; width: 50%; animation: loading 2s infinite ease-in-out; }
        @keyframes loading { 0% { transform: translateX(-100%); } 100% { transform: translateX(200%); } }
        .history-scroll::-webkit-scrollbar { width: 4px; }
        .history-scroll::-webkit-scrollbar-track { background: #f1f1f1; }
        .history-scroll::-webkit-scrollbar-thumb { background: #888; border-radius: 2px; }
        .voucher-container { background: white; color: #333; padding: 20px; border-radius: 10px; position: relative; }
        .voucher-header { text-align: center; border-bottom: 2px dashed #ddd; padding-bottom: 15px; margin-bottom: 15px; }
        .voucher-body { max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 14px; }
        .voucher-row { display: flex; justify-content: space-between; margin-bottom: 5px; }
        .voucher-total { border-top: 2px dashed #ddd; padding-top: 10px; margin-top: 10px; display: flex; justify-content: space-between; font-weight: bold; font-size: 16px; }
        .stamp { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-15deg); font-size: 3rem; color: rgba(74, 59, 50, 0.2); font-weight: bold; border: 3px solid rgba(74, 59, 50, 0.2); padding: 5px 20px; border-radius: 10px; pointer-events: none; }
        .animate-gradient-x { background-size: 200% 200%; animation: gradient-move 3s ease infinite; }
        @keyframes gradient-move { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        .text-shadow { text-shadow: 0 2px 4px rgba(0,0,0,0.2); }
    </style>
    <script>
        // FIX: Aggressively hide loader on any page show (fix for back button)
        window.addEventListener('pageshow', () => {
             const l = document.getElementById('app-loader');
             if(l) l.classList.add('hidden-loader');
        });
        
        window.addEventListener('load', () => { 
            const l = document.getElementById('app-loader'); 
            if(l) {
                l.classList.add('hidden-loader'); 
                // FAILSAFE
                setTimeout(() => l.style.display = 'none', 5000);
            }
            const s = document.getElementById('splash-screen'); 
            if(s) { 
                if(sessionStorage.getItem('splash_shown')){ s.style.display='none'; } 
                else { 
                    setTimeout(()=>{s.style.opacity='0'; setTimeout(()=>{s.style.display='none'; sessionStorage.setItem('splash_shown','true');},700);},1500); 
                } 
            } 
        });
        function showLoader() { const l = document.getElementById('app-loader'); if(l) { l.style.display='flex'; l.classList.remove('hidden-loader'); } }
        function hideLoader() { const l = document.getElementById('app-loader'); if(l) l.classList.add('hidden-loader'); }
        function doLogout() { sessionStorage.removeItem('splash_shown'); showLoader(); }
    </script>
  `;
  const loaderHTML = `<div id="app-loader"><div class="spinner"></div></div>`;
  const splashHTML = `<div id="splash-screen"><img src="https://img.icons8.com/color/144/shop.png" class="splash-logo"><h1 class="text-3xl font-bold text-white tracking-[5px] mb-6">MYANMAR 2D</h1><div class="loading-bar"><div class="loading-progress"></div></div><p class="text-xs text-white/50 mt-4 uppercase tracking-wider">Loading System...</p></div>`;

  if (!currentUser) {
    return new Response(`<!DOCTYPE html><html lang="en"><head><title>Welcome</title>${commonHead}</head><body class="h-screen flex items-center justify-center px-4 bg-[#4a3b32]">${splashHTML} ${loaderHTML}<div class="bg-white text-gray-800 p-6 rounded-xl w-full max-w-sm shadow-2xl text-center"><img src="https://img.icons8.com/color/96/shop.png" class="mx-auto mb-4 w-16"><h1 class="text-2xl font-bold mb-6 text-[#4a3b32]">Myanmar 2D Live</h1><div class="flex justify-center mb-6 border-b"><button onclick="showLogin()" id="tabLogin" class="w-1/2 pb-2 border-b-2 border-[#4a3b32] font-bold text-[#4a3b32]">Login</button><button onclick="showRegister()" id="tabReg" class="w-1/2 pb-2 text-gray-400">Register</button></div><form id="loginForm" action="/login" method="POST" onsubmit="showLoader()"><input type="text" name="username" placeholder="Username" class="w-full p-3 mb-3 border rounded bg-gray-50" required><input type="password" name="password" placeholder="Password" class="w-full p-3 mb-4 border rounded bg-gray-50" required><label class="flex items-center gap-2 text-xs text-gray-600 mb-4 cursor-pointer"><input type="checkbox" name="remember" class="form-checkbox h-4 w-4 text-[#4a3b32]" checked> Remember Me (15 Days)</label><button class="bg-[#4a3b32] text-white font-bold w-full py-3 rounded-lg hover:bg-[#3d3029]">Login</button></form><form id="regForm" action="/register" method="POST" class="hidden" onsubmit="showLoader()"><input type="text" name="username" placeholder="New Username" class="w-full p-3 mb-3 border rounded bg-gray-50" required><input type="password" name="password" placeholder="New Password" class="w-full p-3 mb-4 border rounded bg-gray-50" required><label class="flex items-center gap-2 text-xs text-gray-600 mb-4 cursor-pointer"><input type="checkbox" name="remember" class="form-checkbox h-4 w-4 text-[#4a3b32]" checked> Remember Me (15 Days)</label><button class="bg-[#d97736] text-white font-bold w-full py-3 rounded-lg hover:bg-[#b5602b]">Create Account</button></form></div><script>const p=new URLSearchParams(window.location.search);if(p.get('error')==='invalid_login') Swal.fire('Error','Invalid Username or Password','error');if(p.get('error')==='user_exists') Swal.fire('Error','Username already taken','error');function showLogin(){document.getElementById('loginForm').classList.remove('hidden');document.getElementById('regForm').classList.add('hidden');document.getElementById('tabLogin').classList.add('border-b-2','border-[#4a3b32]','text-[#4a3b32]');document.getElementById('tabLogin').classList.remove('text-gray-400');document.getElementById('tabReg').classList.remove('border-b-2','border-[#4a3b32]','text-[#4a3b32]');document.getElementById('tabReg').classList.add('text-gray-400');}function showRegister(){document.getElementById('loginForm').classList.add('hidden');document.getElementById('regForm').classList.remove('hidden');document.getElementById('tabReg').classList.add('border-b-2','border-[#4a3b32]','text-[#4a3b32]');document.getElementById('tabReg').classList.remove('text-gray-400');document.getElementById('tabLogin').classList.remove('border-b-2','border-[#4a3b32]','text-[#4a3b32]');document.getElementById('tabLogin').classList.add('text-gray-400');}</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const userEntry = await kv.get(["users", currentUser]);
  const userData = userEntry.value as any;
  const balance = userData?.balance || 0;
  const avatar = userData?.avatar || "";

  if (url.pathname === "/profile") {
      const transactions = [];
      const txIter = kv.list({ prefix: ["transactions"] }, { reverse: true, limit: 50 });
      for await (const entry of txIter) {
          const tx = entry.value as any;
          if (tx.user === currentUser) transactions.push(tx);
      }
      const contactEntry = await kv.get(["system", "contact"]);
      const contact = contactEntry.value as any || { kpay_no: "09-", kpay_name: "Admin", wave_no: "09-", wave_name: "Admin", tele_link: "#", kpay_img: "", wave_img: "" };

      return new Response(`<!DOCTYPE html><html lang="en"><head><title>Profile</title>${commonHead}</head><body class="max-w-md mx-auto min-h-screen bg-gray-100 text-gray-800">${loaderHTML}<div class="bg-[#4a3b32] text-white p-6 rounded-b-3xl shadow-lg text-center relative"><a href="/" onclick="showLoader()" class="absolute left-4 top-4 text-white/80 text-2xl"><i class="fas fa-arrow-left"></i></a><div class="relative w-24 h-24 mx-auto mb-3"><div class="w-24 h-24 rounded-full border-4 border-white/20 bg-white overflow-hidden flex items-center justify-center relative">${avatar ? `<img src="${avatar}" class="w-full h-full object-cover">` : `<i class="fas fa-user text-4xl text-[#4a3b32]"></i>`}</div><button onclick="document.getElementById('pInput').click()" class="absolute bottom-0 right-0 bg-yellow-500 text-white rounded-full p-2 shadow-lg border-2 border-[#4a3b32]"><i class="fas fa-camera text-xs"></i></button><input type="file" id="pInput" hidden accept="image/*" onchange="uploadAvatar(this)"></div><h1 class="text-xl font-bold uppercase">${currentUser}</h1><p class="text-white/70 text-sm">${balance.toLocaleString()} Ks</p></div><div class="p-4 space-y-4"><div class="bg-white p-4 rounded-xl shadow-sm"><h3 class="font-bold text-gray-600 mb-3"><i class="fas fa-lock text-yellow-500 mr-2"></i>Change Password</h3><form action="/change_password" method="POST" onsubmit="showLoader()" class="flex gap-2"><input type="password" name="new_password" placeholder="New Password" class="flex-1 border rounded p-2 text-sm" required><button class="bg-[#4a3b32] text-white px-4 py-2 rounded text-sm font-bold">Save</button></form></div><div class="bg-white p-4 rounded-xl shadow-sm"><h3 class="font-bold text-gray-600 mb-3"><i class="fas fa-headset text-blue-500 mr-2"></i>Contact Admin</h3><div class="grid grid-cols-2 gap-2"><div class="bg-blue-50 p-3 rounded-lg text-center border border-blue-100 relative overflow-hidden"><img src="${contact.kpay_img || 'https://img.icons8.com/color/48/k-pay.png'}" class="w-8 h-8 mx-auto mb-1 object-cover rounded-full"><div class="text-xs text-gray-500 font-bold">KPay</div><div class="text-sm font-bold text-blue-800 select-all">${contact.kpay_no}</div><div class="text-[10px] text-gray-400">${contact.kpay_name}</div></div><div class="bg-yellow-50 p-3 rounded-lg text-center border border-yellow-100 relative overflow-hidden"><img src="${contact.wave_img || 'https://img.icons8.com/fluency/48/wave-money.png'}" class="w-8 h-8 mx-auto mb-1 object-cover rounded-full"><div class="text-xs text-gray-500 font-bold">Wave</div><div class="text-sm font-bold text-yellow-800 select-all">${contact.wave_no}</div><div class="text-[10px] text-gray-400">${contact.wave_name}</div></div><a href="${contact.tele_link}" target="_blank" class="col-span-2 bg-blue-500 text-white p-3 rounded-lg text-center font-bold flex items-center justify-center gap-2 hover:bg-blue-600"><i class="fab fa-telegram text-2xl"></i> Contact on Telegram</a></div></div><div class="bg-white p-4 rounded-xl shadow-sm"><h3 class="font-bold text-gray-600 mb-3"><i class="fas fa-history text-green-500 mr-2"></i>Transaction History</h3><div class="space-y-2 h-60 overflow-y-auto history-scroll">${transactions.length === 0 ? '<div class="text-center text-gray-400 text-xs py-4">No transactions yet</div>' : ''}${transactions.map(tx => `<div class="flex justify-between items-center p-2 bg-gray-50 rounded border-l-4 ${tx.type==='TOPUP'?'border-green-500':'border-red-500'}"><div><div class="text-sm font-bold text-gray-700">${tx.type}</div><div class="text-xs text-gray-400">${tx.time}</div></div><div class="font-bold text-gray-700">+${tx.amount.toLocaleString()}</div></div>`).join('')}</div></div></div><script>const p=new URLSearchParams(window.location.search);if(p.get('status')==='pass_changed')Swal.fire('Success','Password Changed Successfully!','success');if(p.get('status')==='error')Swal.fire('Error','Something went wrong','error'); function uploadAvatar(input) { if(input.files && input.files[0]) { const file = input.files[0]; const reader = new FileReader(); reader.onload = function(e) { const img = new Image(); img.src = e.target.result; img.onload = function() { const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d'); const size = 150; canvas.width = size; canvas.height = size; let sSize = Math.min(img.width, img.height); let sx = (img.width - sSize) / 2; let sy = (img.height - sSize) / 2; ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, size, size); const dataUrl = canvas.toDataURL('image/jpeg', 0.7); const fd = new FormData(); fd.append('avatar', dataUrl); showLoader(); fetch('/update_avatar', { method: 'POST', body: fd }).then(res => res.json()).then(d => { hideLoader(); if(d.status==='success') location.reload(); else Swal.fire('Error', 'Upload failed', 'error'); }); } }; reader.readAsDataURL(file); } } </script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const bets = [];
  const iter = kv.list({ prefix: ["bets"] }, { reverse: true, limit: 50 });
  for await (const entry of iter) {
    const b = entry.value as any;
    if (isAdmin || b.user === currentUser) bets.push(b);
  }

  let blockedCount = 0;
  const blockedNumbers = [];
  const blockIter = kv.list({ prefix: ["blocks"] });
  for await (const entry of blockIter) { blockedCount++; blockedNumbers.push(entry.key[1]); }
  blockedNumbers.sort();

  const tipEntry = await kv.get(["system", "tip"]);
  const dailyTip = tipEntry.value || "";
  const contactEntry = await kv.get(["system", "contact"]);
  const contact = contactEntry.value as any || { kpay_no: "", kpay_name: "", wave_no: "", wave_name: "", tele_link: "", kpay_img: "", wave_img: "" };
  const rateEntry = await kv.get(["system", "rate"]);
  const currentRate = rateEntry.value || 80;

  let todaySale = 0;
  let todayPayout = 0;
  if (isAdmin) {
      const todayStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });
      const allBets = kv.list({ prefix: ["bets"] });
      for await (const entry of allBets) {
          const bet = entry.value as any;
          const betDate = new Date(parseInt(entry.key[1])).toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });
          if(betDate === todayStr) {
              todaySale += bet.amount;
              if(bet.status === "WIN") todayPayout += (bet.winAmount || 0);
          }
      }
  }
  const todayProfit = todaySale - todayPayout;

  return new Response(`
    <!DOCTYPE html>
    <html lang="en">
    <head><title>Myanmar 2D</title>${commonHead}</head>
    <body class="max-w-md mx-auto min-h-screen bg-gray-100 pb-10 text-gray-800">
      ${loaderHTML} ${splashHTML}
      <nav class="bg-theme h-14 flex justify-between items-center px-4 text-white shadow-md sticky top-0 z-50">
        <a href="/profile" onclick="showLoader()" class="font-bold text-lg uppercase tracking-wider flex items-center gap-2">
            ${avatar ? `<img src="${avatar}" class="w-8 h-8 rounded-full border border-white">` : `<i class="fas fa-user-circle text-2xl"></i>`}
            ${currentUser}
        </a>
        <div class="flex gap-4 items-center">
           <div class="flex items-center gap-1 bg-white/10 px-3 py-1 rounded-full border border-white/20"><i class="fas fa-wallet text-xs text-yellow-400"></i><span id="navBalance" class="text-sm font-bold">${balance.toLocaleString()} Ks</span></div>
           <a href="/logout" onclick="doLogout()" class="text-xs border border-white/30 px-2 py-1 rounded hover:bg-white/10">Logout</a>
        </div>
      </nav>

      <div class="p-4">
        <div class="card-gradient rounded-2xl p-6 text-center text-white shadow-lg relative overflow-hidden">
          <div class="flex justify-between items-center mb-2 text-gray-300 text-sm"><span id="live_date">Today</span><span class="flex items-center gap-1"><i class="fas fa-circle text-green-500 text-[10px]"></i> Live</span></div>
          <div class="py-2"><div id="live_twod" class="text-8xl font-bold tracking-tighter drop-shadow-md">--</div><div class="text-sm mt-2 opacity-80">Update: <span id="live_time">--:--:--</span></div></div>
          <div class="mt-4 border-t border-white/20 pt-2"><a href="/history" onclick="showLoader()" class="text-xs text-yellow-300 font-bold flex items-center justify-center gap-1 hover:text-white"><i class="fas fa-calendar-alt"></i> View 2D History</a></div>
        </div>
      </div>

      ${dailyTip ? `<div class="px-4 mb-4"><div class="relative overflow-hidden rounded-2xl shadow-lg transform transition hover:scale-105 duration-300"><div class="absolute inset-0 bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-600 animate-gradient-x"></div><div class="relative p-1 bg-gradient-to-r from-cyan-300 to-blue-400 rounded-2xl"><div class="bg-white/10 backdrop-blur-sm rounded-xl p-4 text-center border border-white/30"><div class="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2"><span class="bg-white text-blue-600 px-3 py-1 rounded-full text-xs font-bold shadow-md uppercase tracking-wider flex items-center gap-1"><i class="fas fa-crown text-yellow-500"></i> VIP TIP <i class="fas fa-crown text-yellow-500"></i></span></div><div class="mt-2"><p class="text-white text-shadow font-bold text-lg tracking-wide drop-shadow-md">${dailyTip}</p><div class="mt-1 text-[10px] text-white/80 uppercase font-bold tracking-widest">Good Luck Today!</div></div></div></div></div></div>` : ''}

      ${!isAdmin ? `<div class="px-4 mb-4"><button onclick="openBetModal()" class="w-full bg-theme text-white py-3 rounded-xl font-bold shadow-lg flex justify-center items-center gap-2 hover:bg-[#3d3029]"><i class="fas fa-plus-circle"></i> Place Bet (ထိုးမည်)</button></div>` : ''}

      ${isAdmin ? `
        <div class="px-4 mb-4 space-y-4">
           <div class="grid grid-cols-3 gap-2"><div class="bg-green-100 border border-green-300 p-2 rounded text-center"><div class="text-[10px] font-bold text-green-600">TODAY SALE</div><div class="font-bold text-sm text-green-800">${todaySale.toLocaleString()}</div></div><div class="bg-red-100 border border-red-300 p-2 rounded text-center"><div class="text-[10px] font-bold text-red-600">PAYOUT</div><div class="font-bold text-sm text-red-800">${todayPayout.toLocaleString()}</div></div><div class="bg-blue-100 border border-blue-300 p-2 rounded text-center"><div class="text-[10px] font-bold text-blue-600">PROFIT</div><div class="font-bold text-sm text-blue-800">${todayProfit.toLocaleString()}</div></div></div>
           
           <div class="bg-white p-4 rounded shadow border-l-4 border-purple-500">
             <h3 class="font-bold text-purple-600 mb-2">Add Manual History</h3>
             <form action="/admin/add_history" method="POST" onsubmit="showLoader()" class="space-y-2"><input name="date" type="date" class="w-full border rounded p-2 text-sm" required><div class="flex gap-2"><input name="morning" placeholder="12:01 (e.g 41)" class="w-1/2 border rounded p-2 text-center"><input name="evening" placeholder="4:30 (e.g 92)" class="w-1/2 border rounded p-2 text-center"></div><button class="bg-purple-600 text-white w-full py-2 rounded font-bold text-xs">SAVE RECORD</button></form>
           </div>

           <div class="bg-white p-4 rounded shadow border-l-4 border-red-500">
             <h3 class="font-bold text-red-600 mb-2">Payout & Rates</h3>
             <form action="/admin/rate" method="POST" onsubmit="showLoader()" class="flex gap-2 mb-2"><label class="text-xs font-bold mt-2">Ratio:</label><input name="rate" value="${currentRate}" class="w-16 border rounded p-1 text-center font-bold"><button class="bg-gray-700 text-white px-2 rounded text-xs">SET</button></form>
             <form action="/admin/payout" method="POST" onsubmit="showLoader()" class="flex flex-col gap-2 border-t pt-2"><div class="flex gap-2"><select name="session" class="w-1/3 border rounded p-1 bg-gray-50 text-xs font-bold"><option value="MORNING">12:01 PM</option><option value="EVENING">04:30 PM</option></select><input name="win_number" placeholder="Win No" class="w-1/3 border rounded p-1 text-center font-bold"><button class="bg-red-600 text-white w-1/3 rounded text-xs font-bold">PAYOUT</button></div></form>
           </div>
           <div class="bg-white p-4 rounded shadow border-l-4 border-green-500">
             <h3 class="font-bold text-green-600 mb-2">Topup</h3>
             <form action="/admin/topup" method="POST" onsubmit="showLoader()" class="flex gap-2 mb-2"><input name="username" placeholder="User" class="w-1/3 border rounded p-1 text-sm"><input name="amount" placeholder="Amt" type="number" class="w-1/3 border rounded p-1 text-sm"><button class="bg-green-600 text-white w-1/3 rounded text-xs font-bold">Topup</button></form>
           </div>
           <div class="bg-white p-4 rounded shadow border-l-4 border-blue-500">
             <h3 class="font-bold text-blue-600 mb-2">Payment & Contact Info</h3>
             <form action="/admin/contact" method="POST" onsubmit="showLoader()" class="grid grid-cols-2 gap-2"><input name="kpay_no" value="${contact.kpay_no}" placeholder="KPay No" class="border rounded p-1 text-sm"><input name="kpay_name" value="${contact.kpay_name}" placeholder="KPay Name" class="border rounded p-1 text-sm"><input name="kpay_img" value="${contact.kpay_img}" placeholder="KPay Img URL" class="col-span-2 border rounded p-1 text-sm"><input name="wave_no" value="${contact.wave_no}" placeholder="Wave No" class="border rounded p-1 text-sm"><input name="wave_name" value="${contact.wave_name}" placeholder="Wave Name" class="border rounded p-1 text-sm"><input name="wave_img" value="${contact.wave_img}" placeholder="Wave Img URL" class="col-span-2 border rounded p-1 text-sm"><input name="tele_link" value="${contact.tele_link}" placeholder="Telegram Link" class="col-span-2 border rounded p-1 text-sm"><button class="col-span-2 bg-blue-600 text-white rounded py-1 text-xs font-bold">UPDATE INFO</button></form>
           </div>
           <div class="bg-white p-4 rounded shadow border-l-4 border-purple-500">
             <h3 class="font-bold text-purple-600 mb-2">Lucky Tip</h3>
             <form action="/admin/tip" method="POST" onsubmit="showLoader()" class="flex gap-2"><input name="tip" placeholder="Tip text" class="flex-1 border rounded p-1 text-sm" value="${dailyTip}"><button class="bg-purple-600 text-white px-3 rounded text-xs font-bold">UPDATE</button></form>
           </div>
           <div class="bg-white p-4 rounded shadow border-l-4 border-yellow-500">
             <h3 class="font-bold text-yellow-600 mb-2">Reset Password</h3>
             <form action="/admin/reset_pass" method="POST" onsubmit="showLoader()" class="flex gap-2"><input name="username" placeholder="User" class="w-1/3 border rounded p-1 text-sm" required><input name="password" placeholder="New Pass" class="w-1/3 border rounded p-1 text-sm" required><button class="bg-yellow-600 text-white w-1/3 rounded text-xs font-bold">RESET</button></form>
           </div>
           <div class="bg-white p-4 rounded shadow border-l-4 border-gray-600">
             <h3 class="font-bold text-gray-600 mb-2">Blocks</h3>
             <form action="/admin/block" method="POST" onsubmit="showLoader()"><input type="hidden" name="action" value="add"><div class="flex gap-2 mb-2"><input name="block_val" type="number" placeholder="Num" class="w-1/2 border rounded p-2 text-center font-bold"><select name="block_type" class="w-1/2 border rounded p-2 text-xs font-bold"><option value="direct">Direct</option><option value="head">Head</option><option value="tail">Tail</option></select></div><div class="flex gap-2"><button class="bg-gray-800 text-white flex-1 py-2 rounded text-xs font-bold">BLOCK</button><button type="submit" formaction="/admin/block" name="action" value="clear" class="bg-red-500 text-white w-1/3 py-2 rounded text-xs font-bold">CLEAR</button></div></form>
             <div class="mt-4 border-t pt-2"><label class="text-xs font-bold text-gray-400 mb-2 block">Blocked (${blockedCount}):</label><div class="flex flex-wrap gap-2 max-h-32 overflow-y-auto">${blockedNumbers.map(n => `<form action="/admin/block" method="POST" style="display:inline;"><input type="hidden" name="action" value="unblock"><input type="hidden" name="block_val" value="${n}"><button class="bg-red-100 text-red-600 px-2 py-1 rounded text-xs font-bold border border-red-200 hover:bg-red-200 flex items-center gap-1">${n} <i class="fas fa-times-circle"></i></button></form>`).join('')}</div></div>
           </div>
        </div>` : ''}

      <div class="px-4 space-y-3 mb-6">
        <div class="bg-white rounded-xl p-4 shadow-sm border border-gray-200 flex justify-between text-center"><div class="w-1/3"><div class="text-xs text-gray-400 font-bold">SET</div><div id="set_12" class="font-bold">--</div></div><div class="w-1/3"><div class="text-xs text-gray-400 font-bold">VALUE</div><div id="val_12" class="font-bold">--</div></div><div class="w-1/3"><div class="text-xs text-gray-400 font-bold">2D (12:01)</div><div id="res_12" class="text-xl font-bold text-theme">--</div></div></div>
        <div class="bg-white rounded-xl p-4 shadow-sm border border-gray-200 flex justify-between text-center"><div class="w-1/3"><div class="text-xs text-gray-400 font-bold">SET</div><div id="set_430" class="font-bold">--</div></div><div class="w-1/3"><div class="text-xs text-gray-400 font-bold">VALUE</div><div id="val_430" class="font-bold">--</div></div><div class="w-1/3"><div class="text-xs text-gray-400 font-bold">2D (04:30)</div><div id="res_430" class="text-xl font-bold text-theme">--</div></div></div>
      </div>

      <div class="px-4">
        <div class="flex justify-between items-center mb-2"><h3 class="font-bold text-gray-500 text-sm uppercase tracking-wider">Betting History</h3><div class="flex gap-2"><div class="relative"><input type="text" id="historySearch" onkeyup="filterHistory()" placeholder="Search..." class="border rounded-full px-3 py-1 text-xs focus:outline-none focus:border-yellow-500 w-24 text-center text-black"></div><button onclick="confirmClearHistory()" class="bg-red-100 text-red-500 p-1 rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-200"><i class="fas fa-trash text-xs"></i></button></div></div>
        <div id="historyList" class="space-y-2 h-80 overflow-y-auto history-scroll rounded-lg border border-gray-200 bg-white p-2 shadow-inner">${bets.map(b => `<div class="history-item bg-gray-50 p-3 rounded border-l-4 ${b.status==='WIN'?'border-green-500':b.status==='LOSE'?'border-red-500':'border-yellow-500'} border-b shadow-sm flex justify-between items-center"><div class="truncate w-2/3"><span class="bet-number text-lg font-bold text-gray-800 block truncate">${b.number}</span><span class="text-xs text-gray-400">${b.time}</span></div><div class="text-right"><div class="font-bold text-gray-700">${b.amount.toLocaleString()}</div><div class="text-[10px] font-bold uppercase ${b.status==='WIN'?'text-green-600':b.status==='LOSE'?'text-red-600':'text-yellow-600'}">${b.status}</div></div></div>`).join('')}${bets.length===0?'<div class="text-center text-gray-400 text-sm py-10">No betting history</div>':''}</div>
      </div>

      <div id="betModal" class="fixed inset-0 bg-black/90 hidden z-50 flex items-end justify-center sm:items-center"><div class="bg-white w-full max-w-md rounded-t-2xl sm:rounded-xl p-4 h-auto flex flex-col"><div class="flex justify-between items-center mb-4"><h2 class="text-xl font-bold text-theme">Betting</h2><button onclick="closeBetModal()" class="text-gray-500 text-2xl">&times;</button></div><div class="flex gap-2 mb-4 text-sm font-bold"><button onclick="setTab('direct')" id="btnDirect" class="flex-1 py-2 rounded tab-active">Direct</button><button onclick="setTab('quick')" id="btnQuick" class="flex-1 py-2 rounded tab-inactive">Quick</button></div><form id="betForm" onsubmit="placeBet(event)" class="flex-1 flex flex-col"><div id="tabDirectContent"><label class="text-xs text-gray-500 font-bold">Numbers (comma separated)</label><textarea id="numberInput" name="number" class="w-full h-20 border-2 border-gray-300 rounded-lg p-2 text-lg font-bold text-gray-700 focus:border-[#4a3b32] focus:outline-none" placeholder="Ex: 12, 34, 56"></textarea></div><div id="tabQuickContent" class="hidden space-y-2"><div class="grid grid-cols-2 gap-2"><button type="button" onclick="quickBet('head')" class="bg-gray-200 p-2 rounded font-bold text-gray-700 hover:bg-gray-300">Head (ထိပ်)</button><button type="button" onclick="quickBet('tail')" class="bg-gray-200 p-2 rounded font-bold text-gray-700 hover:bg-gray-300">Tail (နောက်)</button><button type="button" onclick="quickBet('double')" class="bg-gray-200 p-2 rounded font-bold text-gray-700 hover:bg-gray-300">Double (အပူး)</button><button type="button" onclick="quickBet('brake')" class="bg-gray-200 p-2 rounded font-bold text-gray-700 hover:bg-gray-300">Brake (R)</button></div><div id="quickInputArea" class="hidden mt-2 p-2 bg-yellow-50 rounded border border-yellow-200"><label id="quickLabel" class="text-xs font-bold text-gray-600 block mb-1">Enter Number:</label><div class="flex gap-2"><input type="number" id="quickVal" class="flex-1 border rounded p-2 text-center font-bold"><button type="button" onclick="generateNumbers()" class="bg-theme text-white px-4 rounded font-bold">Add</button></div></div></div><div class="mt-4"><label class="text-xs text-gray-500 font-bold">Amount (Per Number)</label><input type="number" name="amount" class="w-full border-2 border-gray-300 rounded-lg p-2 text-xl font-bold text-center mb-4" required><button class="w-full bg-theme text-white py-3 rounded-lg font-bold text-lg">Confirm Bet</button></div></form></div></div>
      <div id="voucherModal" class="fixed inset-0 bg-black/90 hidden z-[100] flex items-center justify-center p-4"><div class="bg-white w-full max-w-sm rounded-lg overflow-hidden shadow-2xl relative"><button onclick="document.getElementById('voucherModal').classList.add('hidden'); window.location.reload();" class="absolute top-2 right-3 text-gray-400 text-2xl">&times;</button><div id="voucherContent" class="p-4"></div><div class="bg-gray-100 p-3 text-center"><button onclick="document.getElementById('voucherModal').classList.add('hidden'); window.location.reload();" class="bg-theme text-white w-full py-2 rounded font-bold">Close</button></div></div></div>

      <script>
        const p = new URLSearchParams(window.location.search);
        if(p.get('status')==='market_closed') Swal.fire({icon:'warning',title:'Market Closed',text:'Betting is currently closed.',confirmButtonColor:'#d97736'});
        if(p.get('status')==='error_min') Swal.fire({icon:'error',title:'Invalid Amount',text:'Minimum bet is 50 Ks',confirmButtonColor:'#d33'});
        if(p.get('status')==='error_max') Swal.fire({icon:'error',title:'Invalid Amount',text:'Maximum bet is 100,000 Ks',confirmButtonColor:'#d33'});

        function filterHistory() { const i = document.getElementById('historySearch'); const f = i.value.trim(); const l = document.getElementById('historyList'); const it = l.getElementsByClassName('history-item'); for(let x=0;x<it.length;x++){ const s = it[x].querySelector('.bet-number'); const t = s.textContent||s.innerText; if(t.indexOf(f)>-1) it[x].style.display=""; else it[x].style.display="none"; } }
        function confirmClearHistory() { Swal.fire({title:'Clear History?',text:"Only finished bets removed.",icon:'warning',showCancelButton:true,confirmButtonColor:'#d33',confirmButtonText:'Yes'}).then((r)=>{if(r.isConfirmed){showLoader();fetch('/clear_history',{method:'POST'}).then(res=>res.json()).then(d=>{hideLoader();Swal.fire('Cleared!',d.count+' records removed.','success').then(()=>window.location.reload());});}}) }
        let currentQuickMode = '';
        function openBetModal() { document.getElementById('betModal').classList.remove('hidden'); }
        function closeBetModal() { document.getElementById('betModal').classList.add('hidden'); }
        function setTab(tab) { const d = document.getElementById('tabDirectContent'); const q = document.getElementById('tabQuickContent'); const bd = document.getElementById('btnDirect'); const bq = document.getElementById('btnQuick'); if(tab==='direct'){ d.classList.remove('hidden'); q.classList.add('hidden'); bd.className="flex-1 py-2 rounded tab-active"; bq.className="flex-1 py-2 rounded tab-inactive"; } else{ d.classList.add('hidden'); q.classList.remove('hidden'); bd.className="flex-1 py-2 rounded tab-inactive"; bq.className="flex-1 py-2 rounded tab-active"; } }
        function quickBet(mode) { const a = document.getElementById('quickInputArea'); const l = document.getElementById('quickLabel'); const i = document.getElementById('quickVal'); if (mode === 'double') { addNumbers(generateDouble()); a.classList.add('hidden'); Swal.fire('Added', 'Double numbers added!', 'success'); } else { currentQuickMode = mode; a.classList.remove('hidden'); i.value = ''; i.focus(); l.innerText = mode === 'brake' ? 'Enter Number (e.g. 12):' : 'Enter Digit (e.g. 5):'; } }
        function generateNumbers() { const v = document.getElementById('quickVal').value; if(!v) return; let n = []; if(currentQuickMode==='head') n=generateHead(v); if(currentQuickMode==='tail') n=generateTail(v); if(currentQuickMode==='brake') n=generateBrake(v); addNumbers(n); document.getElementById('quickVal').value=''; Swal.fire('Added', n.length+' numbers added!', 'success'); }
        function addNumbers(n) { const i = document.getElementById('numberInput'); let c = i.value.trim(); if(c && !c.endsWith(',')) c += ','; i.value = c + n.join(','); }
        function generateHead(d) { let r=[]; for(let i=0;i<10;i++) r.push(d+i); return r; }
        function generateTail(d) { let r=[]; for(let i=0;i<10;i++) r.push(i+d); return r; }
        function generateDouble() { let r=[]; for(let i=0;i<10;i++) r.push(i+\"\"+i); return r; }
        function generateBrake(n) { if(n.length!==2)return[]; const r=n[1]+n[0]; return n===r?[n]:[n,r]; }
        async function placeBet(e) { e.preventDefault(); showLoader(); const fd = new FormData(e.target); try { const res = await fetch('/bet', { method: 'POST', body: fd }); const data = await res.json(); hideLoader(); if (data.status === 'success') { closeBetModal(); showVoucher(data.voucher); } else if (data.status === 'blocked') Swal.fire('Blocked', 'Number '+data.num+' is closed.', 'error'); else if (data.status === 'insufficient_balance') Swal.fire('Error', 'Insufficient Balance', 'error'); else if (data.status === 'market_closed') Swal.fire('Closed', 'Market is currently closed.', 'warning'); else if (data.status === 'error_min') Swal.fire('Error', 'Minimum bet is 50 Ks', 'error'); else if (data.status === 'error_max') Swal.fire('Error', 'Maximum bet is 100,000 Ks', 'error'); else Swal.fire('Error', 'Invalid Bet', 'error'); } catch (err) { hideLoader(); Swal.fire('Error', 'Connection Failed', 'error'); } }
        function showVoucher(v) { const html = \`<div class="voucher-container"><div class="stamp">PAID</div><div class="voucher-header"><h2 class="text-xl font-bold">Myanmar 2D Voucher</h2><div class="text-xs text-gray-500">ID: \${v.id}</div><div class="text-sm mt-1">User: <b>\${v.user}</b></div><div class="text-xs text-gray-400">\${v.date} \${v.time}</div></div><div class="voucher-body">\${v.numbers.map(n => \`<div class="voucher-row"><span>\${n}</span><span>\${v.amountPerNum}</span></div>\`).join('')}</div><div class="voucher-total"><span>TOTAL</span><span>\${v.total} Ks</span></div></div>\`; document.getElementById('voucherContent').innerHTML = html; document.getElementById('voucherModal').classList.remove('hidden'); }
        const API_URL = "https://api.thaistock2d.com/live";
        async function updateData() { try { const res = await fetch(API_URL); const data = await res.json(); 
            const now = new Date();
            const mmDate = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Yangon"}));
            const todayStr = mmDate.getFullYear() + "-" + String(mmDate.getMonth()+1).padStart(2,'0') + "-" + String(mmDate.getDate()).padStart(2,'0');
            const day = mmDate.getDay(); 
            const isWeekend = (day === 0 || day === 6);
            const isSameDay = data.live && data.live.date === todayStr;

            if(data.live) { 
                document.getElementById('live_twod').innerText = (isSameDay && !isWeekend) ? (data.live.twod || "--") : "--"; 
                document.getElementById('live_date').innerText = data.live.date || "Today"; 
                document.getElementById('live_time').innerText = (isSameDay && !isWeekend) ? (data.live.time || "--:--:--") : "--:--:--"; 
            } 
            
            if (data.result) { 
                if (isSameDay && !isWeekend) {
                    if(data.result[1]) { document.getElementById('set_12').innerText = data.result[1].set||"--"; document.getElementById('val_12').innerText = data.result[1].value||"--"; document.getElementById('res_12').innerText = data.result[1].twod||"--"; } 
                    const ev = data.result[3] || data.result[2]; 
                    if(ev) { document.getElementById('set_430').innerText = ev.set||"--"; document.getElementById('val_430').innerText = ev.value||"--"; document.getElementById('res_430').innerText = ev.twod||"--"; } 
                } else {
                    document.getElementById('set_12').innerText = "--"; document.getElementById('val_12').innerText = "--"; document.getElementById('res_12').innerText = "--";
                    document.getElementById('set_430').innerText = "--"; document.getElementById('val_430').innerText = "--"; document.getElementById('res_430').innerText = "--";
                }
            } 
        } catch (e) {} } setInterval(updateData, 2000); updateData();
        function doLogout() { sessionStorage.removeItem('splash_shown'); showLoader(); }
      </script>
    </body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
});
