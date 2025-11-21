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
    // Time Lock Logic
    const now = new Date();
    const mmTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Yangon" }));
    const hour = mmTime.getHours();
    const minute = mmTime.getMinutes();
    const totalMins = hour * 60 + minute;

    const isMorningClose = totalMins >= 710 && totalMins < 735; // 11:50 - 12:15
    const isEveningClose = totalMins >= 950 || totalMins < 480; // 3:50 - 08:00

    if (isMorningClose || isEveningClose) {
        return Response.redirect(url.origin + "/?status=market_closed");
    }

    const form = await req.formData();
    const numbersRaw = form.get("number")?.toString() || ""; 
    const amount = parseInt(form.get("amount")?.toString() || "0");
    
    if(!numbersRaw || amount <= 0) return Response.redirect(url.origin + "/?error=invalid_bet");

    const numberList = numbersRaw.split(",").filter(n => n.trim() !== "");
    const totalCost = numberList.length * amount;

    const userEntry = await kv.get(["users", currentUser]);
    const userData = userEntry.value as any;
    const currentBalance = userData?.balance || 0;

    if (currentBalance < totalCost) {
        return Response.redirect(url.origin + "/?status=insufficient_balance");
    }

    await kv.set(["users", currentUser], { ...userData, balance: currentBalance - totalCost });
    
    const timeString = mmTime.toLocaleString("en-US", { hour: 'numeric', minute: 'numeric', hour12: true });

    for (const num of numberList) {
        const betId = Date.now().toString() + Math.random().toString().substr(2, 5);
        await kv.set(["bets", betId], { 
            user: currentUser, 
            number: num.trim(), 
            amount, 
            status: "PENDING", 
            time: timeString 
        });
    }

    return Response.redirect(url.origin + "/?status=success");
  }

  // Admin Logic
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
      const iter = kv.list({ prefix: ["bets"] });
      for await (const entry of iter) {
        const bet = entry.value as any;
        if (bet.status === "PENDING") {
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
      return new Response(null, { status: 303, headers: { "Location": "/" } });
    }
  }

  // =========================
  // 3. UI RENDERING
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
        
        #app-loader {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.85); z-index: 9999;
            display: flex; justify-content: center; align-items: center;
            transition: opacity 0.3s ease;
        }
        .spinner {
            width: 50px; height: 50px; border: 5px solid #fff;
            border-bottom-color: transparent; border-radius: 50%;
            animation: rotation 1s linear infinite;
        }
        @keyframes rotation { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .hidden-loader { opacity: 0; pointer-events: none; }
        
        .history-scroll::-webkit-scrollbar { width: 4px; }
        .history-scroll::-webkit-scrollbar-track { background: #f1f1f1; }
        .history-scroll::-webkit-scrollbar-thumb { background: #888; border-radius: 2px; }
    </style>
    <script>
        window.addEventListener('load', () => {
            const loader = document.getElementById('app-loader');
            if(loader) loader.classList.add('hidden-loader');
        });
        function showLoader() {
            const loader = document.getElementById('app-loader');
            if(loader) loader.classList.remove('hidden-loader');
        }
    </script>
  `;

  const loaderHTML = `<div id="app-loader"><div class="spinner"></div></div>`;

  if (!currentUser) {
    return new Response(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>Welcome</title>
        ${commonHead}
      </head>
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
          const urlParams = new URLSearchParams(window.location.search);
          if(urlParams.get('error') === 'invalid_login') Swal.fire('Error', 'Invalid Username or Password', 'error');
          if(urlParams.get('error') === 'user_exists') Swal.fire('Error', 'Username already taken', 'error');

          function showLogin() {
            document.getElementById('loginForm').classList.remove('hidden');
            document.getElementById('regForm').classList.add('hidden');
            document.getElementById('tabLogin').classList.add('border-b-2', 'border-[#4a3b32]', 'text-[#4a3b32]');
            document.getElementById('tabLogin').classList.remove('text-gray-400');
            document.getElementById('tabReg').classList.remove('border-b-2', 'border-[#4a3b32]', 'text-[#4a3b32]');
            document.getElementById('tabReg').classList.add('text-gray-400');
          }
          function showRegister() {
            document.getElementById('loginForm').classList.add('hidden');
            document.getElementById('regForm').classList.remove('hidden');
            document.getElementById('tabReg').classList.add('border-b-2', 'border-[#4a3b32]', 'text-[#4a3b32]');
            document.getElementById('tabReg').classList.remove('text-gray-400');
            document.getElementById('tabLogin').classList.remove('border-b-2', 'border-[#4a3b32]', 'text-[#4a3b32]');
            document.getElementById('tabLogin').classList.add('text-gray-400');
          }
        </script>
      </body>
      </html>
    `, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // DASHBOARD
  const userEntry = await kv.get(["users", currentUser]);
  const balance = (userEntry.value as any)?.balance || 0;

  const bets = [];
  const iter = kv.list({ prefix: ["bets"] }, { reverse: true, limit: 50 });
  for await (const entry of iter) {
    const b = entry.value as any;
    if (isAdmin || b.user === currentUser) bets.push(b);
  }

  return new Response(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Myanmar Live 2D/3D</title>
      ${commonHead}
    </head>
    <body class="max-w-md mx-auto min-h-screen bg-gray-100 pb-10 text-gray-800">
      ${loaderHTML}

      <nav class="bg-theme h-14 flex justify-between items-center px-4 text-white shadow-md sticky top-0 z-50">
        <div class="font-bold text-lg uppercase tracking-wider"><i class="fas fa-user-circle mr-2"></i>${currentUser}</div>
        
        <div class="flex gap-4 items-center">
           <div class="flex items-center gap-1 bg-white/10 px-3 py-1 rounded-full border border-white/20">
             <i class="fas fa-wallet text-xs text-yellow-400"></i>
             <span class="text-sm font-bold">${balance.toLocaleString()} Ks</span>
           </div>
           <a href="/logout" onclick="showLoader()" class="text-xs border border-white/30 px-2 py-1 rounded hover:bg-white/10">Logout</a>
        </div>
      </nav>

      <div class="p-4">
        <div class="card-gradient rounded-2xl p-6 text-center text-white shadow-lg relative overflow-hidden">
          <div class="flex justify-between items-center mb-2 text-gray-300 text-sm">
             <span id="live_date">Today</span>
             <span class="flex items-center gap-1"><i class="fas fa-circle text-green-500 text-[10px]"></i> Live</span>
          </div>
          <div class="py-2">
            <div id="live_twod" class="text-8xl font-bold tracking-tighter drop-shadow-md">--</div>
            <div class="text-sm mt-2 opacity-80">Update: <span id="live_time">--:--:--</span></div>
          </div>
        </div>
      </div>

      ${!isAdmin ? `
        <div class="px-4 mb-4">
          <button onclick="openBetModal()" 
            class="w-full bg-theme text-white py-3 rounded-xl font-bold shadow-lg flex justify-center items-center gap-2 hover:bg-[#3d3029]">
            <i class="fas fa-plus-circle"></i> Place Bet (ထိုးမည်)
          </button>
        </div>
      ` : ''}

      ${isAdmin ? `
        <div class="px-4 mb-4">
           <div class="bg-white p-4 rounded shadow border-l-4 border-red-500">
             <h3 class="font-bold text-red-600 mb-2">Admin Panel</h3>
             <form action="/admin/topup" method="POST" onsubmit="showLoader()" class="flex gap-2 mb-2">
               <input name="username" placeholder="User" class="w-1/3 border rounded p-1">
               <input name="amount" placeholder="Amt" type="number" class="w-1/3 border rounded p-1">
               <button class="bg-green-600 text-white w-1/3 rounded text-xs">Topup</button>
             </form>
             <form action="/admin/payout" method="POST" onsubmit="showLoader()" class="flex gap-2">
                <input name="win_number" placeholder="Win No" class="w-2/3 border rounded p-1">
                <button class="bg-red-600 text-white w-1/3 rounded text-xs">Payout</button>
             </form>
           </div>
        </div>
      ` : ''}

      <div class="px-4 space-y-3 mb-6">
        <div class="bg-white rounded-xl p-4 shadow-sm border border-gray-200">
          <div class="flex justify-between items-center border-b pb-2 mb-2">
             <span class="font-bold text-gray-700 text-sm">☀️ 12:01 PM</span>
          </div>
          <div class="flex justify-between text-center">
             <div class="w-1/3"><div class="text-xs text-gray-400 font-bold">SET</div><div id="set_12" class="text-gray-800 font-bold">--</div></div>
             <div class="w-1/3"><div class="text-xs text-gray-400 font-bold">VALUE</div><div id="val_12" class="text-gray-800 font-bold">--</div></div>
             <div class="w-1/3"><div class="text-xs text-gray-400 font-bold">2D</div><div id="res_12" class="text-2xl font-bold text-theme">--</div></div>
          </div>
        </div>
        <div class="bg-white rounded-xl p-4 shadow-sm border border-gray-200">
          <div class="flex justify-between items-center border-b pb-2 mb-2">
             <span class="font-bold text-gray-700 text-sm">🌙 4:30 PM</span>
          </div>
          <div class="flex justify-between text-center">
             <div class="w-1/3"><div class="text-xs text-gray-400 font-bold">SET</div><div id="set_430" class="text-gray-800 font-bold">--</div></div>
             <div class="w-1/3"><div class="text-xs text-gray-400 font-bold">VALUE</div><div id="val_430" class="text-gray-800 font-bold">--</div></div>
             <div class="w-1/3"><div class="text-xs text-gray-400 font-bold">2D</div><div id="res_430" class="text-2xl font-bold text-theme">--</div></div>
          </div>
        </div>
      </div>

      <div class="px-4">
        <h3 class="font-bold text-gray-500 text-sm mb-3 uppercase tracking-wider">Betting History (Last 50)</h3>
        <div class="space-y-2 h-80 overflow-y-auto history-scroll rounded-lg border border-gray-200 bg-white p-2 shadow-inner">
          ${bets.map(b => `
            <div class="bg-gray-50 p-3 rounded border-l-4 ${b.status === 'WIN' ? 'border-green-500' : b.status === 'LOSE' ? 'border-red-500' : 'border-yellow-500'} border-b shadow-sm flex justify-between items-center">
              <div class="truncate w-2/3">
                <span class="text-lg font-bold text-gray-800 block truncate">${b.number}</span>
                <span class="text-xs text-gray-400">${b.time}</span>
              </div>
              <div class="text-right">
                <div class="font-bold text-gray-700">${b.amount.toLocaleString()}</div>
                <div class="text-[10px] font-bold uppercase ${b.status === 'WIN' ? 'text-green-600' : b.status === 'LOSE' ? 'text-red-600' : 'text-yellow-600'}">${b.status}</div>
              </div>
            </div>
          `).join('')}
          ${bets.length === 0 ? '<div class="text-center text-gray-400 text-sm py-10">No betting history</div>' : ''}
        </div>
      </div>

      <div id="betModal" class="fixed inset-0 bg-black/90 hidden z-50 flex items-end justify-center sm:items-center">
         <div class="bg-white w-full max-w-md rounded-t-2xl sm:rounded-xl p-4 h-auto flex flex-col">
           <div class="flex justify-between items-center mb-4">
             <h2 class="text-xl font-bold text-theme">Betting</h2>
             <button onclick="closeBetModal()" class="text-gray-500 text-2xl">&times;</button>
           </div>

           <div class="flex gap-2 mb-4 text-sm font-bold">
             <button onclick="setTab('direct')" id="btnDirect" class="flex-1 py-2 rounded tab-active">Direct</button>
             <button onclick="setTab('quick')" id="btnQuick" class="flex-1 py-2 rounded tab-inactive">Quick</button>
           </div>

           <form action="/bet" method="POST" onsubmit="showLoader()" class="flex-1 flex flex-col">
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

      <script>
        const urlParams = new URLSearchParams(window.location.search);
        const status = urlParams.get('status');

        if(status === 'insufficient_balance') {
           Swal.fire({ icon: 'error', title: 'Insufficient Balance', text: 'Please top up.', confirmButtonColor: '#4a3b32' });
           window.history.replaceState({}, document.title, "/");
        }
        if(status === 'market_closed') {
           Swal.fire({ icon: 'warning', title: 'Market Closed', text: 'Betting is currently closed.', confirmButtonColor: '#d97736' });
           window.history.replaceState({}, document.title, "/");
        }
        if(status === 'success') {
           Swal.fire({ icon: 'success', title: 'Bet Placed!', showConfirmButton: false, timer: 1500 });
           window.history.replaceState({}, document.title, "/");
        }

        let currentQuickMode = '';
        function openBetModal() { document.getElementById('betModal').classList.remove('hidden'); }
        function closeBetModal() { document.getElementById('betModal').classList.add('hidden'); }

        function setTab(tab) {
           const directContent = document.getElementById('tabDirectContent');
           const quickContent = document.getElementById('tabQuickContent');
           const btnDirect = document.getElementById('btnDirect');
           const btnQuick = document.getElementById('btnQuick');

           if(tab === 'direct') {
              directContent.classList.remove('hidden');
              quickContent.classList.add('hidden');
              btnDirect.className = "flex-1 py-2 rounded tab-active";
              btnQuick.className = "flex-1 py-2 rounded tab-inactive";
           } else {
              directContent.classList.add('hidden');
              quickContent.classList.remove('hidden');
              btnDirect.className = "flex-1 py-2 rounded tab-inactive";
              btnQuick.className = "flex-1 py-2 rounded tab-active";
           }
        }

        function quickBet(mode) {
           const area = document.getElementById('quickInputArea');
           const label = document.getElementById('quickLabel');
           const input = document.getElementById('quickVal');
           
           if (mode === 'double') {
               addNumbers(generateDouble());
               area.classList.add('hidden');
               Swal.fire('Added', 'Double numbers added!', 'success');
           } else {
               currentQuickMode = mode;
               area.classList.remove('hidden');
               input.value = '';
               input.focus();
               label.innerText = mode === 'brake' ? 'Enter Number (e.g. 12):' : 'Enter Digit (e.g. 5):';
           }
        }

        function generateNumbers() {
           const val = document.getElementById('quickVal').value;
           if(!val) return;
           let nums = [];
           if(currentQuickMode === 'head') nums = generateHead(val);
           if(currentQuickMode === 'tail') nums = generateTail(val);
           if(currentQuickMode === 'brake') nums = generateBrake(val);
           addNumbers(nums);
           document.getElementById('quickVal').value = '';
           Swal.fire('Added', nums.length + ' numbers added!', 'success');
        }

        function addNumbers(newNums) {
           const input = document.getElementById('numberInput');
           let current = input.value.trim();
           if(current && !current.endsWith(',')) current += ',';
           input.value = current + newNums.join(',');
        }

        function generateHead(digit) { let res=[]; for(let i=0;i<10;i++) res.push(digit+i); return res; }
        function generateTail(digit) { let res=[]; for(let i=0;i<10;i++) res.push(i+digit); return res; }
        function generateDouble() { let res=[]; for(let i=0;i<10;i++) res.push(i+\"\"+i); return res; }
        function generateBrake(num) { if(num.length!==2)return[]; const rev=num[1]+num[0]; return num===rev?[num]:[num,rev]; }

        const API_URL = "https://api.thaistock2d.com/live";
        async function updateData() {
          try {
            const res = await fetch(API_URL);
            const data = await res.json();
            if(data.live) {
                document.getElementById('live_twod').innerText = data.live.twod || "--";
                document.getElementById('live_date').innerText = data.live.date || "Today";
                document.getElementById('live_time').innerText = data.live.time || "--:--:--";
            }
            if (data.result) {
                if(data.result[1]) {
                    document.getElementById('set_12').innerText = data.result[1].set || "--";
                    document.getElementById('val_12').innerText = data.result[1].value || "--";
                    document.getElementById('res_12').innerText = data.result[1].twod || "--";
                }
                const evening = data.result[3] || data.result[2];
                if(evening) {
                    document.getElementById('set_430').innerText = evening.set || "--";
                    document.getElementById('val_430').innerText = evening.value || "--";
                    document.getElementById('res_430').innerText = evening.twod || "--";
                }
            }
          } catch (e) {}
        }
        setInterval(updateData, 2000);
        updateData();
      </script>
    </body>
    </html>
  `, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
});
