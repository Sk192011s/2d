import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const kv = await Deno.openKv();

serve(async (req) => {
  const url = new URL(req.url);
  
  // =========================
  // 1. AUTHENTICATION (Register/Login)
  // =========================
  
  // Register Logic
  if (req.method === "POST" && url.pathname === "/register") {
    const form = await req.formData();
    const username = form.get("username")?.toString();
    const password = form.get("password")?.toString();

    if (!username || !password) {
      return new Response("Username and Password required", { status: 400 });
    }

    const userEntry = await kv.get(["users", username]);
    if (userEntry.value) {
       return new Response("User already exists", { status: 400 });
    }

    await kv.set(["users", username], { password, balance: 0 });
    
    const headers = new Headers({ "Location": "/" });
    headers.set("Set-Cookie", `user=${username}; Path=/; HttpOnly`);
    return new Response(null, { status: 303, headers });
  }

  // Login Logic
  if (req.method === "POST" && url.pathname === "/login") {
    const form = await req.formData();
    const username = form.get("username")?.toString();
    const password = form.get("password")?.toString();

    const userEntry = await kv.get(["users", username]);
    const userData = userEntry.value as any;

    if (!userData || userData.password !== password) {
       return new Response("Invalid Username or Password", { status: 401 });
    }

    const headers = new Headers({ "Location": "/" });
    headers.set("Set-Cookie", `user=${username}; Path=/; HttpOnly`);
    return new Response(null, { status: 303, headers });
  }

  // Logout Logic
  if (url.pathname === "/logout") {
    const headers = new Headers({ "Location": "/" });
    headers.set("Set-Cookie", `user=; Path=/; Max-Age=0`);
    return new Response(null, { status: 303, headers });
  }

  // Check Current User
  const cookies = req.headers.get("Cookie") || "";
  const userCookie = cookies.split(";").find(c => c.trim().startsWith("user="));
  const currentUser = userCookie ? userCookie.split("=")[1].trim() : null;
  const isAdmin = currentUser === "admin";

  // =========================
  // 2. TRANSACTION LOGIC
  // =========================
  if (req.method === "POST" && url.pathname === "/bet" && currentUser) {
    const form = await req.formData();
    const number = form.get("number")?.toString();
    const amount = parseInt(form.get("amount")?.toString() || "0");
    
    const userEntry = await kv.get(["users", currentUser]);
    const userData = userEntry.value as any;
    const currentBalance = userData?.balance || 0;

    if (currentBalance < amount) return new Response("Insufficient Balance", { status: 400 });

    await kv.set(["users", currentUser], { ...userData, balance: currentBalance - amount });
    
    const betId = Date.now().toString();
    await kv.set(["bets", betId], { user: currentUser, number, amount, status: "PENDING", time: new Date().toLocaleTimeString() });
    return new Response(null, { status: 303, headers: { "Location": "/" } });
  }

  // Admin Actions
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
  
  // --- LOGIN / REGISTER PAGE UI ---
  if (!currentUser) {
    return new Response(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>body { background-color: #4a3b32; color: white; }</style>
      </head>
      <body class="h-screen flex items-center justify-center px-4">
        <div class="bg-white text-gray-800 p-6 rounded-xl w-full max-w-sm shadow-2xl text-center">
          <img src="https://img.icons8.com/color/96/shop.png" class="mx-auto mb-4 w-16">
          <h1 class="text-2xl font-bold mb-6 text-[#4a3b32]">Myanmar 2D Live</h1>
          
          <div class="flex justify-center mb-6 border-b">
            <button onclick="showLogin()" id="tabLogin" class="w-1/2 pb-2 border-b-2 border-[#4a3b32] font-bold text-[#4a3b32]">Login</button>
            <button onclick="showRegister()" id="tabReg" class="w-1/2 pb-2 text-gray-400">Register</button>
          </div>

          <form id="loginForm" action="/login" method="POST">
            <input type="text" name="username" placeholder="Username" class="w-full p-3 mb-3 border rounded bg-gray-50" required>
            <input type="password" name="password" placeholder="Password" class="w-full p-3 mb-4 border rounded bg-gray-50" required>
            <button class="bg-[#4a3b32] text-white font-bold w-full py-3 rounded-lg hover:bg-[#3d3029] transition">Login</button>
          </form>

          <form id="regForm" action="/register" method="POST" class="hidden">
            <input type="text" name="username" placeholder="New Username" class="w-full p-3 mb-3 border rounded bg-gray-50" required>
            <input type="password" name="password" placeholder="New Password" class="w-full p-3 mb-4 border rounded bg-gray-50" required>
            <button class="bg-[#d97736] text-white font-bold w-full py-3 rounded-lg hover:bg-[#b5602b] transition">Create Account</button>
          </form>

        </div>

        <script>
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

  // --- MAIN DASHBOARD UI (LOGGED IN) ---

  const userEntry = await kv.get(["users", currentUser]);
  const balance = (userEntry.value as any)?.balance || 0;

  const bets = [];
  const iter = kv.list({ prefix: ["bets"] });
  for await (const entry of iter) {
    const b = entry.value as any;
    if (isAdmin || b.user === currentUser) bets.push(b);
  }
  bets.reverse();

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Myanmar Live 2D/3D</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap');
        body { font-family: 'Roboto', sans-serif; background-color: #f0f2f5; }
        .bg-theme { background-color: #4a3b32; }
        .text-theme { color: #4a3b32; }
        .card-gradient { background: linear-gradient(135deg, #5d4037 0%, #3e2723 100%); }
      </style>
    </head>
    <body class="max-w-md mx-auto min-h-screen bg-gray-100 pb-20">

      <nav class="bg-theme h-14 flex justify-between items-center px-4 text-white shadow-md sticky top-0 z-50">
        <div class="font-bold text-lg">Myanmar 2D</div>
        <div class="flex gap-4 items-center">
           <div class="flex items-center gap-1 bg-white/10 px-2 py-1 rounded">
             <i class="fas fa-wallet text-xs text-yellow-400"></i>
             <span class="text-sm font-bold">${balance}</span>
           </div>
           <a href="/logout" class="text-xs border border-white/30 px-2 py-1 rounded hover:bg-white/10">Logout</a>
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
          <div class="flex justify-center gap-8 mt-4 border-t border-white/20 pt-4">
             <div><div class="text-xs text-gray-300">SET</div><div id="live_set" class="font-bold text-xl">--</div></div>
             <div><div class="text-xs text-gray-300">VALUE</div><div id="live_val" class="font-bold text-xl">--</div></div>
          </div>
        </div>
      </div>

      ${isAdmin ? `
        <div class="px-4 mb-4">
          <div class="bg-white border-l-4 border-red-500 rounded p-4 shadow-sm">
             <h3 class="font-bold text-red-600 mb-3 text-sm uppercase">Admin Panel</h3>
             <form action="/admin/topup" method="POST" class="flex gap-2 mb-3">
               <input name="username" placeholder="Username" class="w-1/3 p-2 bg-gray-50 rounded border text-sm">
               <input name="amount" placeholder="Amount" type="number" class="w-1/3 p-2 bg-gray-50 rounded border text-sm">
               <button class="bg-green-600 text-white w-1/3 rounded text-xs font-bold">ADD MONEY</button>
             </form>
             <form action="/admin/payout" method="POST" class="flex gap-2">
               <input name="win_number" placeholder="Win Number (e.g., 65)" class="w-2/3 p-2 bg-gray-50 rounded border text-sm font-bold text-center">
               <button class="bg-red-600 text-white w-1/3 rounded text-xs font-bold">AUTO PAYOUT</button>
             </form>
          </div>
        </div>
      ` : ''}

      ${!isAdmin ? `
        <div class="px-4 mb-4">
          <button onclick="document.getElementById('betModal').classList.remove('hidden')" 
            class="w-full bg-theme text-white py-3 rounded-xl font-bold shadow-lg flex justify-center items-center gap-2 hover:bg-[#3d3029]">
            <i class="fas fa-plus-circle"></i> Place Bet
          </button>
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
        <h3 class="font-bold text-gray-500 text-sm mb-3 uppercase tracking-wider">Betting History</h3>
        <div class="space-y-2 pb-10">
          ${bets.map(b => `
            <div class="bg-white p-3 rounded-lg border-l-4 ${b.status === 'WIN' ? 'border-green-500' : b.status === 'LOSE' ? 'border-red-500' : 'border-yellow-500'} shadow-sm flex justify-between items-center">
              <div>
                <span class="text-xl font-bold text-gray-800">${b.number}</span>
                <span class="text-xs text-gray-400 ml-2">${b.time}</span>
              </div>
              <div class="text-right">
                <div class="font-bold text-gray-700">${b.amount}</div>
                <div class="text-[10px] font-bold uppercase ${b.status === 'WIN' ? 'text-green-600' : b.status === 'LOSE' ? 'text-red-600' : 'text-yellow-600'}">${b.status}</div>
              </div>
            </div>
          `).join('')}
          ${bets.length === 0 ? '<div class="text-center text-gray-400 text-sm py-4">No bets yet</div>' : ''}
        </div>
      </div>

      <div id="betModal" class="fixed inset-0 bg-black/80 hidden z-50 flex items-center justify-center p-4">
         <div class="bg-white rounded-xl w-full max-w-sm p-6 relative">
           <button onclick="document.getElementById('betModal').classList.add('hidden')" class="absolute top-2 right-3 text-gray-500 text-2xl">&times;</button>
           <h2 class="text-xl font-bold mb-4 text-center text-theme">Place Bet</h2>
           <form action="/bet" method="POST">
             <div class="mb-4">
               <label class="block text-xs font-bold text-gray-500 mb-1">Number (00-99)</label>
               <input type="text" name="number" maxlength="2" class="w-full text-center text-4xl font-bold border rounded p-2 focus:outline-none focus:border-[#4a3b32] text-[#4a3b32]" required autocomplete="off">
             </div>
             <div class="mb-6">
               <label class="block text-xs font-bold text-gray-500 mb-1">Amount</label>
               <input type="number" name="amount" class="w-full text-center text-xl border rounded p-2" required>
             </div>
             <button class="w-full bg-theme text-white py-3 rounded-lg font-bold">Confirm</button>
           </form>
         </div>
      </div>

      <script>
        const API_URL = "https://api.thaistock2d.com/live";
        async function updateData() {
          try {
            const res = await fetch(API_URL);
            const data = await res.json();
            
            if(data.live) {
                document.getElementById('live_twod').innerText = data.live.twod || "--";
                document.getElementById('live_set').innerText = data.live.set || "--";
                document.getElementById('live_val').innerText = data.live.value || "--";
                document.getElementById('live_time').innerText = data.live.time || "--:--:--";
            }

            if (data.result) {
                if(data.result[1]) {
                    document.getElementById('set_12').innerText = data.result[1].set || "--";
                    document.getElementById('val_12').innerText = data.result[1].value || "--";
                    document.getElementById('res_12').innerText = data.result[1].twod || "--";
                }
                // Some APIs use index 3 or 2 for evening
                const evening = data.result[3] || data.result[2];
                if(evening) {
                    document.getElementById('set_430').innerText = evening.set || "--";
                    document.getElementById('val_430').innerText = evening.value || "--";
                    document.getElementById('res_430').innerText = evening.twod || "--";
                }
            }
          } catch (e) { console.log("Error fetching data"); }
        }
        setInterval(updateData, 2000);
        updateData();
      </script>
    </body>
    </html>
  `;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
});
