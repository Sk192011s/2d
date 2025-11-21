import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const kv = await Deno.openKv();

serve(async (req) => {
  const url = new URL(req.url);
  
  // =========================
  // 1. AUTH (Login/Register)
  // =========================
  if (req.method === "POST" && url.pathname === "/register") {
    const form = await req.formData();
    const username = form.get("username")?.toString();
    const password = form.get("password")?.toString();

    if (!username || !password) return Response.redirect(url.origin + "/?error=missing_fields");

    const userEntry = await kv.get(["users", username]);
    if (userEntry.value) return Response.redirect(url.origin + "/?error=user_exists");

    await kv.set(["users", username], { password, balance: 0 });
    
    const headers = new Headers({ "Location": "/" });
    headers.set("Set-Cookie", `user=${username}; Path=/; HttpOnly`);
    return new Response(null, { status: 303, headers });
  }

  if (req.method === "POST" && url.pathname === "/login") {
    const form = await req.formData();
    const username = form.get("username")?.toString();
    const password = form.get("password")?.toString();

    const userEntry = await kv.get(["users", username]);
    const userData = userEntry.value as any;

    if (!userData || userData.password !== password) {
       return Response.redirect(url.origin + "/?error=invalid_login");
    }

    const headers = new Headers({ "Location": "/" });
    headers.set("Set-Cookie", `user=${username}; Path=/; HttpOnly`);
    return new Response(null, { status: 303, headers });
  }

  if (url.pathname === "/logout") {
    const headers = new Headers({ "Location": "/" });
    headers.set("Set-Cookie", `user=; Path=/; Max-Age=0`);
    return new Response(null, { status: 303, headers });
  }

  const cookies = req.headers.get("Cookie") || "";
  const userCookie = cookies.split(";").find(c => c.trim().startsWith("user="));
  const currentUser = userCookie ? userCookie.split("=")[1].trim() : null;
  const isAdmin = currentUser === "admin";

  // =========================
  // 2. BETTING LOGIC
  // =========================
  if (req.method === "POST" && url.pathname === "/bet" && currentUser) {
    const now = new Date();
    const mmString = now.toLocaleString("en-US", { timeZone: "Asia/Yangon", hour12: false });
    const timePart = mmString.split(", ")[1];
    const [h, m] = timePart.split(":").map(Number);
    const totalMins = h * 60 + m;

    const isMorningClose = totalMins >= 710 && totalMins < 735; 
    const isEveningClose = totalMins >= 950 || totalMins < 480; 

    if (isMorningClose || isEveningClose) {
        return new Response(JSON.stringify({ status: "market_closed" }), { headers: { "content-type": "application/json" } });
    }

    const form = await req.formData();
    const numbersRaw = form.get("number")?.toString() || ""; 
    const amount = parseInt(form.get("amount")?.toString() || "0");
    
    if(!numbersRaw || amount <= 0) return new Response(JSON.stringify({ status: "invalid_bet" }), { headers: { "content-type": "application/json" } });

    const numberList = numbersRaw.split(",").filter(n => n.trim() !== "");
    
    for (const num of numberList) {
        const isBlocked = await kv.get(["blocks", num.trim()]);
        if (isBlocked.value) {
            return new Response(JSON.stringify({ status: "blocked", num: num.trim() }), { headers: { "content-type": "application/json" } });
        }
    }

    const totalCost = numberList.length * amount;
    const userEntry = await kv.get(["users", currentUser]);
    const userData = userEntry.value as any;
    const currentBalance = userData?.balance || 0;

    if (currentBalance < totalCost) {
        return new Response(JSON.stringify({ status: "insufficient_balance" }), { headers: { "content-type": "application/json" } });
    }

    await kv.set(["users", currentUser], { ...userData, balance: currentBalance - totalCost });
    
    const timeString = new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon", hour: 'numeric', minute: 'numeric', hour12: true });
    const dateString = new Date().toLocaleString("en-US", { timeZone: "Asia/Yangon", day: 'numeric', month: 'short', year: 'numeric' });

    for (const num of numberList) {
        const betId = Date.now().toString() + Math.random().toString().substr(2, 5);
        await kv.set(["bets", betId], { 
            user: currentUser, 
            number: num.trim(), 
            amount, 
            status: "PENDING", 
            time: timeString,
            rawMins: totalMins
        });
    }

    return new Response(JSON.stringify({ 
        status: "success",
        voucher: {
            user: currentUser,
            date: dateString,
            time: timeString,
            numbers: numberList,
            amountPerNum: amount,
            total: totalCost,
            id: Date.now().toString().slice(-6)
        }
    }), { headers: { "content-type": "application/json" } });
  }

  // =========================
  // 3. ADMIN LOGIC
  // =========================
  if (isAdmin && req.method === "POST") {
    if (url.pathname === "/admin/topup") {
      const form = await req.formData();
      const targetUser = form.get("username")?.toString();
      const amount = parseInt(form.get("amount")?.toString() || "0");
      if(targetUser) {
        const userEntry = await kv.get(["users", targetUser]);
        const userData = userEntry.value as any;
        if(userData) {
            await kv.set(["users", targetUser], { ...userData, balance: (userData.balance || 0) + amount });
        }
      }
      return new Response(null, { status: 303, headers: { "Location": "/" } });
    }
    if (url.pathname === "/admin/payout") {
      const form = await req.formData();
      const winNumber = form.get("win_number")?.toString();
      const session = form.get("session")?.toString(); 

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
                const winAmount = bet.amount * 80;
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
  }

  // =========================
  // 4. UI RENDERING
  // =========================
  const commonHead = `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap');
        body { font-family: 'Roboto', sans-serif; background-color: #4a3b32; color: white; }
        .bg-theme { background-color: #4a3b32; }
        .text-theme { color: #4a3b32; }
        .card-gradient { background: linear-gradient(135deg, #5d4037 0%, #3e2723 100%); }
        .tab-active { background-color: #4a3b32; color: white; }
        .tab-inactive { background-color: #eee; color: #666; }
        #app-loader { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 9999; display: flex; justify-content: center; align-items: center; transition: opacity 0.3s ease; }
        .spinner { width: 50px; height: 50px; border: 5px solid #fff; border-bottom-color: transparent; border-radius: 50%; animation: rotation 1s linear infinite; }
        @keyframes rotation { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .hidden-loader { opacity: 0; pointer-events: none; }
        .history-scroll::-webkit-scrollbar { width: 4px; }
        .history-scroll::-webkit-scrollbar-track { background: #f1f1f1; }
        .history-scroll::-webkit-scrollbar-thumb { background: #888; border-radius: 2px; }
        .voucher-container { background: white; color: #333; padding: 20px; border-radius: 10px; position: relative; }
        .voucher-header { text-align: center; border-bottom: 2px dashed #ddd; padding-bottom: 15px; margin-bottom: 15px; }
        .voucher-body { max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 14px; }
        .voucher-row { display: flex; justify-content: space-between; margin-bottom: 5px; }
        .voucher-total { border-top: 2px dashed #ddd; padding-top: 10px; margin-top: 10px; display: flex; justify-content: space-between; font-weight: bold; font-size: 16px; }
        .stamp { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-15deg); font-size: 3rem; color: rgba(74, 59, 50, 0.2); font-weight: bold; border: 3px solid rgba(74, 59, 50, 0.2); padding: 5px 20px; border-radius: 10px; pointer-events: none; }
    </style>
    <script>
        window.addEventListener('load', () => { const l = document.getElementById('app-loader'); if(l) l.classList.add('hidden-loader'); });
        function showLoader() { const l = document.getElementById('app-loader'); if(l) l.classList.remove('hidden-loader'); }
        function hideLoader() { const l = document.getElementById('app-loader'); if(l) l.classList.add('hidden-loader'); }
    </script>
  `;
  const loaderHTML = `<div id="app-loader"><div class="spinner"></div></div>`;

  if (!currentUser) {
    return new Response(`
      <!DOCTYPE html>
      <html lang="en">
      <head><title>Welcome</title>${commonHead}</head>
      <body class="h-screen flex items-center justify-center px-4 bg-[#4a3b32]">
        ${loaderHTML}
        <div class="bg-white text-gray-800 p-6 rounded-xl w-full max-w-sm shadow-2xl text-center">
          <img src="https://img.icons8.com/color/96/shop.png" class="mx-auto mb-4 w-16">
          <h1 class="text-2xl font-bold mb-6 text-[#4a3b32]">Myanmar 2D Live</h1>
          <div class="flex justify-center mb-6 border-b">
            <button onclick="showLogin()" id="tabLogin" class="w-1/2 pb-2 border-b-2 border-[#4a3b32] font-bold text-[#4a3b32]">Login</button>
            <button onclick="showRegister()" id="tabReg" class="w-1/2 pb-2 text-gray-400">Register</button>
          </div>
          <form id="loginForm" action="/login" method="POST" onsubmit="showLoader()">
            <input type="text" name="username" placeholder="Username" class="w-full p-3 mb-3 border rounded bg-gray-50" required>
            <input type="password" name="password" placeholder="Password" class="w-full p-3 mb-4 border rounded bg-gray-50" required>
            <button class="bg-[#4a3b32] text-white font-bold w-full py-3 rounded-lg hover:bg-[#3d3029]">Login</button>
          </form>
          <form id="regForm" action="/register" method="POST" class="hidden" onsubmit="showLoader()">
            <input type="text" name="username" placeholder="New Username" class="w-full p-3 mb-3 border rounded bg-gray-50" required>
            <input type="password" name="password" placeholder="New Password" class="w-full p-3 mb-4 border rounded bg-gray-50" required>
            <button class="bg-[#d97736] text-white font-bold w-full py-3 rounded-lg hover:bg-[#b5602b]">Create Account</button>
          </form>
        </div>
        <script>
          const p = new URLSearchParams(window.location.search);
          if(p.get('error')==='invalid_login') Swal.fire('Error','Invalid Username or Password','error');
          if(p.get('error')==='user_exists') Swal.fire('Error','Username already taken','error');
          function showLogin(){ document.getElementById('loginForm').classList.remove('hidden'); document.getElementById('regForm').classList.add('hidden'); document.getElementById('tabLogin').classList.add('border-b-2','border-[#4a3b32]','text-[#4a3b32]'); document.getElementById('tabLogin').classList.remove('text-gray-400'); document.getElementById('tabReg').classList.remove('border-b-2','border-[#4a3b32]','text-[#4a3b32]'); document.getElementById('tabReg').classList.add('text-gray-400'); }
          function showRegister(){ document.getElementById('loginForm').classList.add('hidden'); document.getElementById('regForm').classList.remove('hidden'); document.getElementById('tabReg').classList.add('border-b-2','border-[#4a3b32]','text-[#4a3b32]'); document.getElementById('tabReg').classList.remove('text-gray-400'); document.getElementById('tabLogin').classList.remove('border-b-2','border-[#4a3b32]','text-[#4a3b32]'); document.getElementById('tabLogin').classList.add('text-gray-400'); }
        </script>
      </body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const userEntry = await kv.get(["users", currentUser]);
  const balance = (userEntry.value as any)?.balance || 0;
  const bets = [];
  const iter = kv.list({ prefix: ["bets"] }, { reverse: true, limit: 50 });
  for await (const entry of iter) {
    const b = entry.value as any;
    if (isAdmin || b.user === currentUser) bets.push(b);
  }

  let blockedCount = 0;
  const blockedNumbers = [];
  const blockIter = kv.list({ prefix: ["blocks"] });
  for await (const entry of blockIter) {
      blockedCount++;
      blockedNumbers.push(entry.key[1]);
  }
  blockedNumbers.sort();

  return new Response(`
    <!DOCTYPE html>
    <html lang="en">
    <head><title>Myanmar 2D</title>${commonHead}</head>
    <body class="max-w-md mx-auto min-h-screen bg-gray-100 pb-10 text-gray-800">
      ${loaderHTML}
      <nav class="bg-theme h-14 flex justify-between items-center px-4 text-white shadow-md sticky top-0 z-50">
        <div class="font-bold text-lg uppercase tracking-wider"><i class="fas fa-user-circle mr-2"></i>${currentUser}</div>
        <div class="flex gap-4 items-center">
           <div class="flex items-center gap-1 bg-white/10 px-3 py-1 rounded-full border border-white/20">
             <i class="fas fa-wallet text-xs text-yellow-400"></i><span id="navBalance" class="text-sm font-bold">${balance.toLocaleString()} Ks</span>
           </div>
           <a href="/logout" onclick="showLoader()" class="text-xs border border-white/30 px-2 py-1 rounded hover:bg-white/10">Logout</a>
        </div>
      </nav>

      <div class="p-4">
        <div class="card-gradient rounded-2xl p-6 text-center text-white shadow-lg relative overflow-hidden">
          <div class="flex justify-between items-center mb-2 text-gray-300 text-sm">
             <span id="live_date">Today</span><span class="flex items-center gap-1"><i class="fas fa-circle text-green-500 text-[10px]"></i> Live</span>
          </div>
          <div class="py-2">
            <div id="live_twod" class="text-8xl font-bold tracking-tighter drop-shadow-md">--</div>
            <div class="text-sm mt-2 opacity-80">Update: <span id="live_time">--:--:--</span></div>
          </div>
        </div>
      </div>

      ${!isAdmin ? `
        <div class="px-4 mb-4">
          <button onclick="openBetModal()" class="w-full bg-theme text-white py-3 rounded-xl font-bold shadow-lg flex justify-center items-center gap-2 hover:bg-[#3d3029]">
            <i class="fas fa-plus-circle"></i> Place Bet (ထိုးမည်)
          </button>
        </div>` : ''}

      ${isAdmin ? `
        <div class="px-4 mb-4 space-y-4">
           <div class="bg-white p-4 rounded shadow border-l-4 border-red-500">
             <h3 class="font-bold text-red-600 mb-2">Admin Panel</h3>
             <form action="/admin/topup" method="POST" onsubmit="showLoader()" class="flex gap-2 mb-2">
               <input name="username" placeholder="User" class="w-1/3 border rounded p-1 text-sm">
               <input name="amount" placeholder="Amt" type="number" class="w-1/3 border rounded p-1 text-sm">
               <button class="bg-green-600 text-white w-1/3 rounded text-xs font-bold">Topup</button>
             </form>
             <form action="/admin/payout" method="POST" onsubmit="showLoader()" class="flex flex-col gap-2 border-t pt-2">
                <div class="flex gap-2">
                   <select name="session" class="w-1/3 border rounded p-1 bg-gray-50 text-xs font-bold">
                      <option value="MORNING">12:01 PM</option><option value="EVENING">04:30 PM</option>
                   </select>
                   <input name="win_number" placeholder="Win No" class="w-1/3 border rounded p-1 text-center font-bold">
                   <button class="bg-red-600 text-white w-1/3 rounded text-xs font-bold">PAYOUT</button>
                </div>
             </form>
           </div>
           <div class="bg-white p-4 rounded shadow border-l-4 border-gray-600">
             <h3 class="font-bold text-gray-600 mb-2">Manage Blocks</h3>
             <form action="/admin/block" method="POST" onsubmit="showLoader()">
                <input type="hidden" name="action" value="add">
                <div class="flex gap-2 mb-2">
                   <input name="block_val" type="number" placeholder="Num" class="w-1/2 border rounded p-2 text-center font-bold">
                   <select name="block_type" class="w-1/2 border rounded p-2 text-xs font-bold">
                      <option value="direct">Direct</option><option value="head">Head</option><option value="tail">Tail</option>
                   </select>
                </div>
                <div class="flex gap-2">
                    <button class="bg-gray-800 text-white flex-1 py-2 rounded text-xs font-bold">BLOCK</button>
                    <button type="submit" formaction="/admin/block" name="action" value="clear" class="bg-red-500 text-white w-1/3 py-2 rounded text-xs font-bold">CLEAR</button>
                </div>
             </form>
             <div class="mt-4 border-t pt-2">
                 <label class="text-xs font-bold text-gray-400 mb-2 block">Blocked (${blockedCount}):</label>
                 <div class="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                    ${blockedNumbers.map(n => `
                        <form action="/admin/block" method="POST" style="display:inline;">
                            <input type="hidden" name="action" value="unblock"><input type="hidden" name="block_val" value="${n}">
                            <button class="bg-red-100 text-red-600 px-2 py-1 rounded text-xs font-bold border border-red-200 hover:bg-red-200 flex items-center gap-1">${n} <i class="fas fa-times-circle"></i></button>
                        </form>`).join('')}
                 </div>
             </div>
           </div>
        </div>` : ''}

      <div class="px-4 space-y-3 mb-6">
        <div class="bg-white rounded-xl p-4 shadow-sm border border-gray-200 flex justify-between text-center">
            <div class="w-1/3"><div class="text-xs text-gray-400 font-bold">SET</div><div id="set_12" class="font-bold">--</div></div>
            <div class="w-1/3"><div class="text-xs text-gray-400 font-bold">VALUE</div><div id="val_12" class="font-bold">--</div></div>
            <div class="w-1/3"><div class="text-xs text-gray-400 font-bold">2D (12:01)</div><div id="res_12" class="text-xl font-bold text-theme">--</div></div>
        </div>
        <div class="bg-white rounded-xl p-4 shadow-sm border border-gray-200 flex justify-between text-center">
            <div class="w-1/3"><div class="text-xs text-gray-400 font-bold">SET</div><div id="set_430" class="font-bold">--</div></div>
            <div class="w-1/3"><div class="text-xs text-gray-400 font-bold">VALUE</div><div id="val_430" class="font-bold">--</div></div>
            <div class="w-1/3"><div class="text-xs text-gray-400 font-bold">2D (04:30)</div><div id="res_430" class="text-xl font-bold text-theme">--</div></div>
        </div>
      </div>

      <div class="px-4">
        <div class="flex justify-between items-center mb-2">
            <h3 class="font-bold text-gray-500 text-sm uppercase tracking-wider">Betting History (Last 50)</h3>
            <div class="relative">
                <input type="text" id="historySearch" onkeyup="filterHistory()" placeholder="Search No..." class="border rounded-full px-3 py-1 text-xs focus:outline-none focus:border-yellow-500 w-32 text-center text-black">
                <i class="fas fa-search absolute right-3 top-1.5 text-gray-400 text-xs"></i>
            </div>
        </div>
        <div id="historyList" class="space-y-2 h-80 overflow-y-auto history-scroll rounded-lg border border-gray-200 bg-white p-2 shadow-inner">
          ${bets.map(b => `
            <div class="history-item bg-gray-50 p-3 rounded border-l-4 ${b.status==='WIN'?'border-green-500':b.status==='LOSE'?'border-red-500':'border-yellow-500'} border-b shadow-sm flex justify-between items-center">
              <div class="truncate w-2/3"><span class="bet-number text-lg font-bold text-gray-800 block truncate">${b.number}</span><span class="text-xs text-gray-400">${b.time}</span></div>
              <div class="text-right"><div class="font-bold text-gray-700">${b.amount.toLocaleString()}</div><div class="text-[10px] font-bold uppercase ${b.status==='WIN'?'text-green-600':b.status==='LOSE'?'text-red-600':'text-yellow-600'}">${b.status}</div></div>
            </div>`).join('')}
          ${bets.length===0?'<div class="text-center text-gray-400 text-sm py-10">No betting history</div>':''}
        </div>
      </div>

      <div id="betModal" class="fixed inset-0 bg-black/90 hidden z-50 flex items-end justify-center sm:items-center">
         <div class="bg-white w-full max-w-md rounded-t-2xl sm:rounded-xl p-4 h-auto flex flex-col">
           <div class="flex justify-between items-center mb-4"><h2 class="text-xl font-bold text-theme">Betting</h2><button onclick="closeBetModal()" class="text-gray-500 text-2xl">&times;</button></div>
           <div class="flex gap-2 mb-4 text-sm font-bold"><button onclick="setTab('direct')" id="btnDirect" class="flex-1 py-2 rounded tab-active">Direct</button><button onclick="setTab('quick')" id="btnQuick" class="flex-1 py-2 rounded tab-inactive">Quick</button></div>
           <form id="betForm" onsubmit="placeBet(event)" class="flex-1 flex flex-col">
             <div id="tabDirectContent">
                <label class="text-xs text-gray-500 font-bold">Numbers (comma separated)</label>
                <textarea id="numberInput" name="number" class="w-full h-20 border-2 border-gray-300 rounded-lg p-2 text-lg font-bold text-gray-700 focus:border-[#4a3b32] focus:outline-none" placeholder="Ex: 12, 34, 56"></textarea>
             </div>
             <div id="tabQuickContent" class="hidden space-y-2">
                <div class="grid grid-cols-2 gap-2">
                   <button type="button" onclick="quickBet('head')" class="bg-gray-200 p-2 rounded font-bold text-gray-700 hover:bg-gray-300">Head (ထိပ်)</button>
                   <button type="button" onclick="quickBet('tail')" class="bg-gray-200 p-2 rounded font-bold text-gray-700 hover:bg-gray-300">Tail (နောက်)</button>
                   <button type="button" onclick="quickBet('double')" class="bg-gray-200 p-2 rounded font-bold text-gray-700 hover:bg-gray-300">Double (အပူး)</button>
                   <button type="button" onclick="quickBet('brake')" class="bg-gray-200 p-2 rounded font-bold text-gray-700 hover:bg-gray-300">Brake (R)</button>
                </div>
                <div id="quickInputArea" class="hidden mt-2 p-2 bg-yellow-50 rounded border border-yellow-200">
                   <label id="quickLabel" class="text-xs font-bold text-gray-600 block mb-1">Enter Number:</label>
                   <div class="flex gap-2">
                     <input type="number" id="quickVal" class="flex-1 border rounded p-2 text-center font-bold">
                     <button type="button" onclick="generateNumbers()" class="bg-theme text-white px-4 rounded font-bold">Add</button>
                   </div>
                </div>
             </div>
             <div class="mt-4">
               <label class="text-xs text-gray-500 font-bold">Amount (Per Number)</label>
               <input type="number" name="amount" class="w-full border-2 border-gray-300 rounded-lg p-2 text-xl font-bold text-center mb-4" required>
               <button class="w-full bg-theme text-white py-3 rounded-lg font-bold text-lg">Confirm Bet</button>
             </div>
           </form>
         </div>
      </div>

      <div id="voucherModal" class="fixed inset-0 bg-black/90 hidden z-[100] flex items-center justify-center p-4">
         <div class="bg-white w-full max-w-sm rounded-lg overflow-hidden shadow-2xl relative">
            <button onclick="document.getElementById('voucherModal').classList.add('hidden'); window.location.reload();" class="absolute top-2 right-3 text-gray-400 text-2xl">&times;</button>
            <div id="voucherContent" class="p-4"></div>
            <div class="bg-gray-100 p-3 text-center">
                <button onclick="document.getElementById('voucherModal').classList.add('hidden'); window.location.reload();" class="bg-theme text-white w-full py-2 rounded font-bold">Close</button>
            </div>
         </div>
      </div>

      <script>
        const p = new URLSearchParams(window.location.search);
        if(p.get('status')==='market_closed') Swal.fire({icon:'warning',title:'Market Closed',text:'Betting is currently closed.',confirmButtonColor:'#d97736'});

        // HISTORY SEARCH FILTER
        function filterHistory() {
            const input = document.getElementById('historySearch');
            const filter = input.value.trim();
            const list = document.getElementById('historyList');
            const items = list.getElementsByClassName('history-item');
            for (let i = 0; i < items.length; i++) {
                const numberSpan = items[i].querySelector('.bet-number');
                const txtValue = numberSpan.textContent || numberSpan.innerText;
                if (txtValue.indexOf(filter) > -1) {
                    items[i].style.display = "";
                } else {
                    items[i].style.display = "none";
                }
            }
        }

        let currentQuickMode = '';
        function openBetModal() { document.getElementById('betModal').classList.remove('hidden'); }
        function closeBetModal() { document.getElementById('betModal').classList.add('hidden'); }
        function setTab(tab) {
           const d = document.getElementById('tabDirectContent'); const q = document.getElementById('tabQuickContent');
           const bd = document.getElementById('btnDirect'); const bq = document.getElementById('btnQuick');
           if(tab==='direct'){ d.classList.remove('hidden'); q.classList.add('hidden'); bd.className="flex-1 py-2 rounded tab-active"; bq.className="flex-1 py-2 rounded tab-inactive"; }
           else{ d.classList.add('hidden'); q.classList.remove('hidden'); bd.className="flex-1 py-2 rounded tab-inactive"; bq.className="flex-1 py-2 rounded tab-active"; }
        }
        function quickBet(mode) {
           const a = document.getElementById('quickInputArea'); const l = document.getElementById('quickLabel'); const i = document.getElementById('quickVal');
           if (mode === 'double') { addNumbers(generateDouble()); a.classList.add('hidden'); Swal.fire('Added', 'Double numbers added!', 'success'); } 
           else { currentQuickMode = mode; a.classList.remove('hidden'); i.value = ''; i.focus(); l.innerText = mode === 'brake' ? 'Enter Number (e.g. 12):' : 'Enter Digit (e.g. 5):'; }
        }
        function generateNumbers() {
           const v = document.getElementById('quickVal').value; if(!v) return;
           let n = [];
           if(currentQuickMode==='head') n=generateHead(v);
           if(currentQuickMode==='tail') n=generateTail(v);
           if(currentQuickMode==='brake') n=generateBrake(v);
           addNumbers(n); document.getElementById('quickVal').value=''; Swal.fire('Added', n.length+' numbers added!', 'success');
        }
        function addNumbers(n) { const i = document.getElementById('numberInput'); let c = i.value.trim(); if(c && !c.endsWith(',')) c += ','; i.value = c + n.join(','); }
        function generateHead(d) { let r=[]; for(let i=0;i<10;i++) r.push(d+i); return r; }
        function generateTail(d) { let r=[]; for(let i=0;i<10;i++) r.push(i+d); return r; }
        function generateDouble() { let r=[]; for(let i=0;i<10;i++) r.push(i+\"\"+i); return r; }
        function generateBrake(n) { if(n.length!==2)return[]; const r=n[1]+n[0]; return n===r?[n]:[n,r]; }

        async function placeBet(e) {
            e.preventDefault(); showLoader(); const formData = new FormData(e.target);
            try {
                const res = await fetch('/bet', { method: 'POST', body: formData }); const data = await res.json(); hideLoader();
                if (data.status === 'success') { closeBetModal(); showVoucher(data.voucher); } 
                else if (data.status === 'blocked') Swal.fire('Blocked', 'Number '+data.num+' is closed.', 'error');
                else if (data.status === 'insufficient_balance') Swal.fire('Error', 'Insufficient Balance', 'error');
                else if (data.status === 'market_closed') Swal.fire('Closed', 'Market is currently closed.', 'warning');
                else Swal.fire('Error', 'Invalid Bet', 'error');
            } catch (err) { hideLoader(); Swal.fire('Error', 'Connection Failed', 'error'); }
        }

        function showVoucher(v) {
            const html = \`<div class="voucher-container"><div class="stamp">PAID</div><div class="voucher-header"><h2 class="text-xl font-bold">Myanmar 2D Voucher</h2><div class="text-xs text-gray-500">ID: \${v.id}</div><div class="text-sm mt-1">User: <b>\${v.user}</b></div><div class="text-xs text-gray-400">\${v.date} \${v.time}</div></div><div class="voucher-body">\${v.numbers.map(n => \`<div class="voucher-row"><span>\${n}</span><span>\${v.amountPerNum}</span></div>\`).join('')}</div><div class="voucher-total"><span>TOTAL</span><span>\${v.total} Ks</span></div></div>\`;
            document.getElementById('voucherContent').innerHTML = html; document.getElementById('voucherModal').classList.remove('hidden');
        }

        const API_URL = "https://api.thaistock2d.com/live";
        async function updateData() {
          try {
            const res = await fetch(API_URL); const data = await res.json();
            if(data.live) { document.getElementById('live_twod').innerText = data.live.twod || "--"; document.getElementById('live_date').innerText = data.live.date || "Today"; document.getElementById('live_time').innerText = data.live.time || "--:--:--"; }
            if (data.result) {
                if(data.result[1]) { document.getElementById('set_12').innerText = data.result[1].set||"--"; document.getElementById('val_12').innerText = data.result[1].value||"--"; document.getElementById('res_12').innerText = data.result[1].twod||"--"; }
                const ev = data.result[3] || data.result[2];
                if(ev) { document.getElementById('set_430').innerText = ev.set||"--"; document.getElementById('val_430').innerText = ev.value||"--"; document.getElementById('res_430').innerText = ev.twod||"--"; }
            }
          } catch (e) {}
        }
        setInterval(updateData, 2000); updateData();
      </script>
    </body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
});
