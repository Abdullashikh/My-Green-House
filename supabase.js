import { createClient } from "https://esm.sh";

export const config = {
  supabaseUrl: "https://supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZ2loZ2JycnlkZ3R1eGNobGpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwMTM5MzQsImV4cCI6MjExMDU4OTkzNH0.OQJARsv1yuaD4JvHsjPKdZ_eQTZXL9rGFiEjfKlp1zA",
  botApiUrl: "https://YOUR_BOT_API_HOST"
};

const isConfigured = !config.supabaseUrl.includes("YOUR_PROJECT_ID")
  && !config.supabaseAnonKey.includes("YOUR_SUPABASE_ANON_KEY");

export const supabase = isConfigured
  ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null;

function requireClient() {
  if (!supabase) {
    throw new Error("Сначала укажите SUPABASE_URL и SUPABASE_ANON_KEY в supabase.js.");
  }
  return supabase;
}

function unwrap(result) {
  if (result.error) throw result.error;
  return result.data;
}

export async function signInWithTelegram(initData) {
  requireClient();
  if (!config.botApiUrl || config.botApiUrl.includes("YOUR_BOT_API_HOST")) {
    throw new Error("Укажите адрес API бота в supabase.js.");
  }
  const response = await fetch(`${config.botApiUrl.replace(/\/$/, "")}/auth/telegram`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ init_data: initData })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || "Не удалось выполнить вход через Telegram.");
  return unwrap(await supabase.auth.setSession({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token
  }));
}

export async function signInWithEmail(email) {
  const client = requireClient();
  return unwrap(await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split("#")[0] }
  }));
}

export async function signOut() {
  return unwrap(await requireClient().auth.signOut());
}

export async function getSession() {
  return unwrap(await requireClient().auth.getSession());
}

export function onAuthChange(callback) {
  return requireClient().auth.onAuthStateChange(callback);
}

export async function getTasks() {
  return unwrap(await requireClient().from("tasks")
    .select("id,creator_id,volunteer_id,category,title,description,lat,lng,reward_mghc,status,photo_before_url,photo_after_url,created_at,completed_at")
    .order("created_at", { ascending: false }).limit(1000)) || [];
}

export async function getDashboardStats() {
  return unwrap(await requireClient().rpc("get_public_dashboard_stats"));
}

export async function getProfile(userId) {
  return unwrap(await requireClient().from("profiles").select("*").eq("id", userId).single());
}

export async function getLeaderboard() {
  return unwrap(await requireClient().rpc("get_public_leaderboard")) || [];
}

export async function getTransactions(userId) {
  return unwrap(await requireClient().from("transactions")
    .select("id,amount,reason,created_at").eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(30)) || [];
}

export async function getShopItems() {
  return unwrap(await requireClient().from("shop_items")
    .select("id,partner_name,title,description,price_mghc,icon")
    .eq("is_active", true).order("price_mghc")) || [];
}

export async function getVouchers(userId) {
  return unwrap(await requireClient().from("vouchers")
    .select("id,promo_code,is_used,created_at,item:shop_items(title,partner_name)")
    .eq("user_id", userId).order("created_at", { ascending: false })) || [];
}

export async function uploadTaskPhoto(file, taskId, stage, userId) {
  const client = requireClient();
  const compressed = await compressImage(file);
  const path = `${userId}/${taskId}-${stage}.jpg`;
  const upload = await client.storage.from("task-photos").upload(path, compressed, {
    contentType: "image/jpeg", upsert: false
  });
  unwrap(upload);
  return client.storage.from("task-photos").getPublicUrl(path).data.publicUrl;
}

export function compressImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) {
      reject(new Error("Выберите изображение в формате JPEG, PNG или WebP."));
      return;
    }
    const image = new Image();
    const source = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(source);
      const scale = Math.min(1, 800 / image.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Не удалось обработать изображение в этом браузере."));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Не удалось сжать изображение."));
      }, "image/jpeg", 0.75);
    };
    image.onerror = () => {
      URL.revokeObjectURL(source);
      reject(new Error("Не удалось открыть выбранное изображение."));
    };
    image.src = source;
  });
}

export async function createTask(task, photo, userId) {
  const client = requireClient();
  const id = crypto.randomUUID();
  const photoBeforeUrl = await uploadTaskPhoto(photo, id, "before", userId);
  return unwrap(await client.from("tasks").insert({
    id, ...task, creator_id: userId, status: "open", photo_before_url: photoBeforeUrl
  }).select().single());
}

export async function claimTask(taskId) {
  return unwrap(await requireClient().rpc("claim_task", { task_id_input: taskId }));
}

export async function submitTask(taskId, photo, userId) {
  const client = requireClient();
  const url = await uploadTaskPhoto(photo, taskId, "after", userId);
  return unwrap(await client.rpc("submit_task_for_review", {
    task_id_input: taskId, photo_after_url_input: url
  }));
}

export async function buyItem(itemId) {
  return unwrap(await requireClient().rpc("purchase_shop_item", { item_id_input: itemId }));
}

export async function approveTask(taskId) {
  return unwrap(await requireClient().rpc("approve_task_and_reward", { task_id_input: taskId }));
}

export async function updateName(userId, fullName) {
  return unwrap(await requireClient().from("profiles")
    .update({ full_name: fullName }).eq("id", userId).select().single());
}
