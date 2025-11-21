import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const kv = await Deno.openKv();

serve(async (req) => {
  const url = new URL(req.url);
  
  // =========================
  // 1. Login & System Logic
  // =========================
  if (req.method === "POST" && url.pathname === "/login") {
    const form = await req.formData();
    const username = form.get("username")?.toString();
    if (!username) return new Response("Username Required", { status: 400 });
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
  // 2. Betting & Admin Logic
  // =========================
  if (req.method === "POST" && url.pathname === "/bet" && currentUser) {
    const form = await req.formData();
    const number = form.get("number")?.toString();
    const amount = parseInt(form.get("amount")?.toString() || "0");
    const userEntry = await kv.get(["users", currentUser]);
    const currentBalance = (userEntry.value as any)?.balance || 0;

    if (currentBalance < amount) return new Response("လက်ကျန်ငွေ မလုံလောက်ပါ", { status: 400 });

    await kv.set(["users", currentUser], { ...userEntry.value, balance: currentBalance - amount });
    const betId = Date.now().toString();
    await kv.set(["bets", betId], { user: currentUser, number, amount, status: "pending", time: new Date().toLocaleString() });
    return new Response(null, { status: 303, headers: { "Location": "/" } });
  }

  if (isAdmin && req.method === "POST") {
    if (url.pathname === "/admin/topup") {
      const form = await req.formData();
      const targetUser = form.get("username")?.toString();
      const amount = parseInt(form.get("amount")?.toString() || "0");
      if(targetUser) {
        const userEntry = await kv.get(["users", targetUser]);
        const oldBalance = (userEntry.value as any)?.balance || 0;
        await kv.set(["users", targetUser], { balance: oldBalance + amount });
      }
      return new Response(null, { status: 303, headers: { "Location": "/" } });
    }
    if (url.pathname === "/admin/payout") {
      const form = await req.formData();
      const winNumber = form.get("win_number")?.toString();
      const iter = kv.list({ prefix: ["bets"] });
      for await (const entry of iter) {
        const bet = entry.value as any;
        if (bet.status === "pending") {
          if (bet.number === winNumber) {
            const winAmount = bet.amount * 80;
            const userEntry = await kv.get(["users", bet.user]);
            const currentBal = (userEntry.value as any)?.balance || 0;
            await kv.set(["users", bet.user], { balance: currentBal + winAmount });
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
  // 3. UI Rendering (Complete Clone)
  // =========================
  
  // Login Page
  if (!currentUser) {
    return new Response(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
        <style>body { background-color: #4a3b32; color: white; }</style>
      </head>
      <body class="h-screen flex items-center justify-center">
        <div class="bg-white text-gray-800 p-6 rounded-lg w-80 text-center shadow-xl">
          <img src="https://img.icons8.com/color/96/shop.png" class="mx-auto mb-4 w-16">
          <h1 class="text-2xl font-bold mb-4 text-[#4a3b32]">Myanmar 2D Live</h1>
          <form action="/login" method="POST">
            <input type="text" name="username" placeholder="သင့်နာမည် (Username)" class="w-full p-3 mb-4 border rounded bg-gray-100" required>
            <button class="bg-[#4a3b32] text-white font-bold w-full py-3 rounded hover:bg-[#3d3029]">အကောင့်ဝင်မည်</button>
          </form>
        </div>
      </body>
      </html>
    `, { headers: { "content-type": "text/html" } });
  }

  // Fetch User Data
  const userEntry = await kv.get(["users", currentUser]);
  const balance = (userEntry.value as any)?.balance || 0;

  // Fetch Bets
  const bets = [];
  const iter = kv.list({ prefix: ["bets"] });
  for await (const entry of iter) {
    const b = entry.value as any;
    if (isAdmin || b.user === currentUser) bets.push(b);
  }
  bets.reverse();

  // Main Dashboard HTML (UI Clone)
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
        .session-card { background-color: #fff; border: 1px solid #e0e0e0; }
      </style>
    </head>
    <body class="max-w-md mx-auto min-h-screen bg-gray-100 pb-20">

      <nav class="bg-theme h-14 flex justify-between items-center px-4 text-white shadow-md sticky top-0 z-50">
        <i class="fas fa-bars text-xl cursor-pointer"></i>
        <div class="font-bold text-lg">Myanmar 2D/3D</div>
        <div class="flex gap-4">
           <div class="flex items-center gap-1 bg-white/10 px-2 rounded">
             <i class="fas fa-wallet text-xs"></i>
             <span class="text-sm font-bold">${balance}</span>
           </div>
           <a href="/logout"><i class="fas fa-sign-out-alt"></i></a>
        </div>
      </nav>

      <div class="bg-yellow-100 text-yellow-800 text-sm py-2 px-2 overflow-hidden whitespace-nowrap">
        <marquee>MyanmarLive 2D/3D ဝဘ်ဆိုဒ်မှ ကြိုဆိုပါသည်။ Admin ဆက်သွယ်ရန် - 09xxxxxxxxx</marquee>
      </div>

      <div class="p-4">
        <div class="card-gradient rounded-2xl p-6 text-center text-white shadow-lg relative overflow-hidden">
          <div class="absolute top-0 right-0 opacity-10 transform translate-x-4 -translate-y-4">
            <i class="fas fa-chart-line text-9xl"></i>
          </div>
          
          <div class="flex justify-between items-center mb-2 text-gray-300 text-sm">
             <span id="live_date">Loading...</span>
             <span class="flex items-center gap-1"><i class="fas fa-circle text-green-500 text-[10px]"></i> Live</span>
          </div>

          <div class="py-2">
            <div id="live_twod" class="text-8xl font-bold tracking-tighter drop-shadow-md">--</div>
            <div class="text-sm mt-2 opacity-80">Update: <span id="live_time">--:--:--</span></div>
          </div>
          
          <div class="flex justify-center gap-8 mt-4 border-t border-white/20 pt-4">
             <div>
               <div class="text-xs text-gray-300">SET</div>
               <div id="live_set" class="font-bold text-xl">--</div>
             </div>
             <div>
               <div class="text-xs text-gray-300">VALUE</div>
               <div id="live_val" class="font-bold text-xl">--</div>
             </div>
          </div>
        </div>
      </div>

      ${isAdmin ? `
        <div class="px-4 mb-4">
          <div class="bg-red-100 border border-red-300 rounded p-3">
             <h3 class="font-bold text-red-800 mb-2">Admin Controls</h3>
             <form action="/admin/topup" method="POST" class="flex gap-2 mb-2">
               <input name="username" placeholder="User" class="w-1/3 p-1 rounded border">
               <input name="amount" placeholder="Amount" class="w-1/3 p-1 rounded border">
               <button class="bg-green-600 text-white px-3 rounded text-xs font-bold">ADD</button>
             </form>
             <form action="/admin/payout" method="POST" class="flex gap-2">
               <input name="win_number" placeholder="Win Number" class="w-2/3 p-1 rounded border text-center font-bold">
               <button class="bg-red-600 text-white w-1/3 rounded text-xs font-bold">PAYOUT</button>
             </form>
          </div>
        </div>
      ` : ''}

      ${!isAdmin ? `
        <div class="px-4 mb-4">
          <button onclick="document.getElementById('betModal').classList.remove('hidden')" 
            class="w-full bg-theme text-white py-3 rounded-xl font-bold shadow-lg flex justify-center items-center gap-2">
            <i class="fas fa-plus-circle"></i> ထိုးမည် (Betting)
          </button>
        </div>
      ` : ''}

      <div class="px-4 space-y-3 mb-6">
        <div class="bg-white rounded-xl p-4 shadow-sm border border-gray-200">
          <div class="flex justify-between items-center border-b pb-2 mb-2">
             <span class="font-bold text-gray-700">☀️ 12:01 PM</span>
             <i class="fas fa-clock text-gray-300"></i>
          </div>
          <div class="flex justify-between text-center">
             <div class="w-1/3">
               <div class="text-xs text-gray-400 font-bold">SET</div>
               <div id="set_12" class="text-gray-800 font-bold">--</div>
             </div>
             <div class="w-1/3">
               <div class="text-xs text-gray-400 font-bold">VALUE</div>
               <div id="val_12" class="text-gray-800 font-bold">--</div>
             </div>
             <div class="w-1/3">
               <div class="text-xs text-gray-400 font-bold">2D</div>
               <div id="res_12" class="text-2xl font-bold text-theme">--</div>
             </div>
          </div>
        </div>

        <div class="bg-white rounded-xl p-4 shadow-sm border border-gray-200">
          <div class="flex justify-between items-center border-b pb-2 mb-2">
             <span class="font-bold text-gray-700">🌙 4:30 PM</span>
             <i class="fas fa-moon text-gray-300"></i>
          </div>
          <div class="flex justify-between text-center">
             <div class="w-1/3">
               <div class="text-xs text-gray-400 font-bold">SET</div>
               <div id="set_430" class="text-gray-800 font-bold">--</div>
             </div>
             <div class="w-1/3">
               <div class="text-xs text-gray-400 font-bold">VALUE</div>
               <div id="val_430" class="text-gray-800 font-bold">--</div>
             </div>
             <div class="w-1/3">
               <div class="text-xs text-gray-400 font-bold">2D</div>
               <div id="res_430" class="text-2xl font-bold text-theme">--</div>
             </div>
          </div>
        </div>
      </div>

      <div class="px-4 grid grid-cols-2 gap-3 mb-6">
         <div class="bg-white p-3 rounded-xl shadow-sm border text-center">
            <div class="text-xs font-bold text-gray-400 mb-1">Modern (9:30)</div>
            <div id="modern_930" class="text-xl font-bold text-gray-700">--</div>
         </div>
         <div class="bg-white p-3 rounded-xl shadow-sm border text-center">
            <div class="text-xs font-bold text-gray-400 mb-1">Internet (9:30)</div>
            <div id="internet_930" class="text-xl font-bold text-gray-700">--</div>
         </div>
         <div class="bg-white p-3 rounded-xl shadow-sm border text-center">
            <div class="text-xs font-bold text-gray-400 mb-1">Modern (2:00)</div>
            <div id="modern_200" class="text-xl font-bold text-gray-700">--</div>
         </div>
         <div class="bg-white p-3 rounded-xl shadow-sm border text-center">
            <div class="text-xs font-bold text-gray-400 mb-1">Internet (2:00)</div>
            <div id="internet_200" class="text-xl font-bold text-gray-700">--</div>
         </div>
      </div>

      <div class="px-4">
        <h3 class="font-bold text-gray-700 mb-3">မှတ်တမ်း (History)</h3>
        <div class="space-y-2">
          ${bets.map(b => `
            <div class="bg-white p-3 rounded-lg border-l-4 ${b.status === 'WIN' ? 'border-green-500' : b.status === 'LOSE' ? 'border-red-500' : 'border-yellow-500'} shadow-sm flex justify-between items-center">
              <div>
                <span class="text-xl font-bold text-gray-800">${b.number}</span>
                <span class="text-xs text-gray-400 ml-2">${b.time.split(',')[1]}</span>
              </div>
              <div class="text-right">
                <div class="font-bold text-gray-700">${b.amount} Ks</div>
                <div class="text-[10px] font-bold uppercase ${b.status === 'WIN' ? 'text-green-600' : b.status === 'LOSE' ? 'text-red-600' : 'text-yellow-600'}">${b.status}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <div id="betModal" class="fixed inset-0 bg-black/80 hidden z-50 flex items-center justify-center p-4">
         <div class="bg-white rounded-xl w-full max-w-sm p-6 relative">
           <button onclick="document.getElementById('betModal').classList.add('hidden')" class="absolute top-2 right-3 text-gray-500 text-xl">&times;</button>
           <h2 class="text-xl font-bold mb-4 text-center text-theme">ထိုးမည့်ဂဏန်းရွေးပါ</h2>
           
           <form action="/bet" method="POST">
             <div class="mb-4">
               <label class="block text-xs font-bold text-gray-500 mb-1">ဂဏန်း (00-99)</label>
               <input type="text" name="number" maxlength="2" class="w-full text-center text-3xl font-bold border rounded p-2 focus:outline-none focus:border-brown-500" required>
             </div>
             <div class="mb-6">
               <label class="block text-xs font-bold text-gray-500 mb-1">ပမာဏ (ကျပ်)</label>
               <input type="number" name="amount" class="w-full text-center text-xl border rounded p-2" required>
             </div>
             <button class="w-full bg-theme text-white py-3 rounded-lg font-bold">ထိုးမည်</button>
           </form>
         </div>
      </div>

      <script>
        const API_URL = "https://api.thaistock2d.com/live";
        
        async function updateData() {
          try {
            const res = await fetch(API_URL);
            const data = await res.json();
            
            // Live Data
            document.getElementById('live_twod').innerText = data.live.twod || "--";
            document.getElementById('live_set').innerText = data.live.set || "--";
            document.getElementById('live_val').innerText = data.live.value || "--";
            document.getElementById('live_time').innerText = data.live.time || "--:--:--";
            document.getElementById('live_date').innerText = data.live.date || "Today";

            // Morning Results (12:01)
            if (data.result && data.result[1]) {
               document.getElementById('set_12').innerText = data.result[1].set || "--";
               document.getElementById('val_12').innerText = data.result[1].value || "--";
               document.getElementById('res_12').innerText = data.result[1].twod || "--";
            }

            // Evening Results (4:30) - usually index 3 or check structure
            if (data.result && data.result[3]) {
               document.getElementById('set_430').innerText = data.result[3].set || "--";
               document.getElementById('val_430').innerText = data.result[3].value || "--";
               document.getElementById('res_430').innerText = data.result[3].twod || "--";
            }

            // Note: Modern/Internet data might need a different API or scraping
            // leaving placeholders for now or mapping if available in 'result'
            
          } catch (e) {
            console.log("Data fetch error");
          }
        }

        // Update every 2 seconds
        setInterval(updateData, 2000);
        updateData();
      </script>

    </body>
    </html>
  `;

  return new Response(html, { headers: { "content-type": "text/html" } });
});
