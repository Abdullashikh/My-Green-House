import {
  config, supabase, signInWithTelegram, signInWithEmail, signOut, getSession, onAuthChange,
  getTasks, getDashboardStats, getProfile, getLeaderboard, getTransactions, getShopItems,
  getVouchers, createTask, claimTask, submitTask, buyItem, approveTask, updateName
} from "./supabase.js";

const categories = {
  trash: { label: "Мусор", reward: 25 },
  dump: { label: "Стихийная свалка", reward: 50 },
  water: { label: "Водоём", reward: 40 },
  trees: { label: "Зелёные зоны", reward: 30 }
};
const statuses = {
  open: "Нужна помощь", in_progress: "В работе", review: "На проверке", completed: "Выполнено"
};
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);
const byId = (id) => document.getElementById(id);
let session = null;
let profile = null;
let tasks = [];
let taskMap;
let reportMap;
let reportMarker;
let selectedLocation = null;
let mapMarkers = [];
let refreshTimer;

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  node.textContent = message;
  byId("toast-region").append(node);
  window.setTimeout(() => node.remove(), 4200);
}

function formatNumber(value) {
  return new Intl.NumberFormat("ru-RU").format(Number(value) || 0);
}

function getRank(completed) {
  if (completed >= 20) return "Страж чистого города";
  if (completed >= 5) return "Активист района";
  return "Новичок природы";
}

function setTheme() {
  const telegram = window.Telegram?.WebApp;
  if (!telegram) return;
  telegram.ready();
  telegram.expand();
  if (telegram.colorScheme === "dark") document.body.classList.add("telegram-dark");
  telegram.onEvent("themeChanged", () => {
    document.body.classList.toggle("telegram-dark", telegram.colorScheme === "dark");
  });
}

function initMaps() {
  if (!window.L) {
    toast("Не удалось загрузить карты. Проверьте подключение к интернету.", true);
    return;
  }
  const start = [43.2389, 76.8897];
  taskMap = L.map("task-map", { scrollWheelZoom: false }).setView(start, 11);
  reportMap = L.map("report-map", { scrollWheelZoom: false }).setView(start, 11);
  for (const map of [taskMap, reportMap]) {
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
  }
  reportMap.on("click", (event) => selectLocation(event.latlng.lat, event.latlng.lng));
}

function selectLocation(lat, lng) {
  selectedLocation = { lat, lng };
  if (reportMarker) reportMarker.remove();
  reportMarker = L.marker([lat, lng]).addTo(reportMap);
  byId("selected-location").textContent = `Выбрана точка: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function goTo(viewName) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === viewName));
  if (viewName === "report" && reportMap) window.setTimeout(() => reportMap.invalidateSize(), 50);
  if (viewName === "tasks" && taskMap) window.setTimeout(() => taskMap.invalidateSize(), 50);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function taskMarkup(task) {
  const category = categories[task.category]?.label || "Задача";
  const description = task.description || "Подробности не указаны.";
  const userId = session?.user?.id;
  const beforePhoto = safePhotoUrl(task.photo_before_url);
  const afterPhoto = safePhotoUrl(task.photo_after_url);
  let action = "";
  if (task.status === "open" && userId && task.creator_id !== userId) {
    action = `<button class="text-button" data-action="claim" data-id="${escapeHtml(task.id)}">Взять задачу</button>`;
  } else if (task.status === "in_progress" && userId && task.volunteer_id === userId) {
    action = `<label class="text-button">Фото «ПОСЛЕ»<input class="after-photo hidden" data-id="${escapeHtml(task.id)}" type="file" accept="image/jpeg,image/png,image/webp"></label>`;
  } else if (task.status === "review" && profile?.role === "moderator") {
    action = `<button class="text-button" data-action="approve" data-id="${escapeHtml(task.id)}">Подтвердить уборку</button>`;
  }
  return `<article class="task-card">
    <div class="task-card-top"><div><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(description)}</p></div><span class="status-pill status-${escapeHtml(task.status)}">${escapeHtml(statuses[task.status] || task.status)}</span></div>
    ${beforePhoto ? `<a class="task-photo-link" href="${escapeHtml(beforePhoto)}" target="_blank" rel="noopener noreferrer"><img class="task-photo" src="${escapeHtml(beforePhoto)}" alt="Фото места до уборки" loading="lazy"></a>` : ""}
    ${afterPhoto ? `<a class="task-photo-link" href="${escapeHtml(afterPhoto)}" target="_blank" rel="noopener noreferrer"><img class="task-photo" src="${escapeHtml(afterPhoto)}" alt="Фотоотчёт после уборки" loading="lazy"></a>` : ""}
    <div class="task-meta"><span class="task-category">${escapeHtml(category)}</span><div class="task-actions"><strong class="reward">🪙 ${formatNumber(task.reward_mghc)}</strong><button class="text-button" data-action="locate" data-id="${escapeHtml(task.id)}">📍 На карте</button>${action}</div></div>
  </article>`;
}

function safePhotoUrl(value) {
  try {
    const url = new URL(value);
    const base = new URL(config.supabaseUrl);
    if (url.protocol !== "https:" || url.origin !== base.origin || !url.pathname.includes("/storage/v1/object/public/task-photos/")) return "";
    return url.href;
  } catch {
    return "";
  }
}

function renderTasks() {
  const query = byId("task-search").value.trim().toLocaleLowerCase("ru");
  const category = byId("category-filter").value;
  const status = byId("status-filter").value;
  const filtered = tasks.filter((task) => {
    const text = `${task.title} ${task.description || ""}`.toLocaleLowerCase("ru");
    return (!query || text.includes(query)) && (!category || task.category === category) && (!status || task.status === status);
  });
  byId("task-count").textContent = formatNumber(filtered.length);
  byId("task-list").innerHTML = filtered.length
    ? filtered.map(taskMarkup).join("")
    : '<div class="empty-state">По этим фильтрам задач нет. Попробуйте изменить поиск.</div>';

  mapMarkers.forEach((marker) => marker.remove());
  mapMarkers = [];
  if (taskMap) {
    filtered.forEach((task) => {
      const marker = L.marker([task.lat, task.lng], {
        icon: L.divIcon({ className: "", html: `<div class="map-pin pin-${escapeHtml(task.status)}"></div>`, iconSize: [24, 24], iconAnchor: [12, 24] })
      }).addTo(taskMap);
      marker.bindPopup(`<strong>${escapeHtml(task.title)}</strong><br>${escapeHtml(categories[task.category]?.label || "Задача")} · ${escapeHtml(statuses[task.status] || task.status)}<br>🪙 ${formatNumber(task.reward_mghc)} MGHC`);
      marker.taskId = task.id;
      mapMarkers.push(marker);
    });
  }
}

function renderStats(stats) {
  byId("stat-total").textContent = formatNumber(stats.total);
  byId("stat-open").textContent = formatNumber(stats.open);
  byId("stat-done").textContent = formatNumber(stats.completed);
  byId("stat-paid").textContent = formatNumber(stats.paid);
}

function renderProfile() {
  if (!profile) {
    byId("header-balance").textContent = "0";
    byId("header-rating").textContent = "0";
    byId("shop-balance").textContent = "0";
    byId("profile-balance").textContent = "0";
    byId("profile-rating").textContent = "0";
    byId("profile-completed").textContent = "0";
    byId("profile-name").textContent = "Гость";
    byId("profile-rank").textContent = "Новичок природы";
    byId("sign-in-button").classList.remove("hidden");
    byId("sign-out-button").classList.add("hidden");
    byId("edit-name-button").classList.add("hidden");
    return;
  }
  byId("header-balance").textContent = formatNumber(profile.mghc_balance);
  byId("header-rating").textContent = formatNumber(profile.rating);
  byId("shop-balance").textContent = formatNumber(profile.mghc_balance);
  byId("profile-balance").textContent = formatNumber(profile.mghc_balance);
  byId("profile-rating").textContent = formatNumber(profile.rating);
  byId("profile-completed").textContent = formatNumber(profile.completed_tasks);
  byId("profile-name").textContent = profile.full_name || "Участник";
  byId("profile-rank").textContent = getRank(profile.completed_tasks);
  byId("sign-in-button").classList.add("hidden");
  byId("sign-out-button").classList.remove("hidden");
  byId("edit-name-button").classList.remove("hidden");
}

async function loadProfileData() {
  if (!session?.user?.id) {
    profile = null;
    renderProfile();
    byId("transaction-list").innerHTML = '<div class="empty-state">Войдите, чтобы увидеть историю баланса.</div>';
    byId("voucher-list").innerHTML = '<div class="empty-state">Войдите, чтобы увидеть свои ваучеры.</div>';
    return;
  }
  const userId = session.user.id;
  const [profileResult, transactionResult, voucherResult] = await Promise.allSettled([
    getProfile(userId), getTransactions(userId), getVouchers(userId)
  ]);
  if (profileResult.status === "fulfilled") {
    profile = profileResult.value;
    renderProfile();
    renderTasks();
  } else {
    toast(`Не удалось загрузить профиль: ${profileResult.reason.message}`, true);
  }
  if (transactionResult.status === "fulfilled") {
    const list = transactionResult.value;
    byId("transaction-list").innerHTML = list.length ? list.map((item) => `
      <div class="transaction-row"><span>${escapeHtml(item.reason)}<br><small>${new Date(item.created_at).toLocaleDateString("ru-RU")}</small></span><strong class="${item.amount > 0 ? "positive" : "negative"}">${item.amount > 0 ? "+" : ""}${formatNumber(item.amount)} MGHC</strong></div>`).join("")
      : '<div class="empty-state">История операций пока пуста.</div>';
  } else toast(`Не удалось загрузить историю: ${transactionResult.reason.message}`, true);
  if (voucherResult.status === "fulfilled") {
    byId("voucher-list").innerHTML = voucherResult.value.length ? voucherResult.value.map((voucher) => `
      <div class="voucher-row"><div><strong>${escapeHtml(voucher.item?.title || "Партнёрский ваучер")}</strong><small>${escapeHtml(voucher.item?.partner_name || "")} · ${voucher.is_used ? "уже использован" : "действителен"}</small></div><span class="voucher-code">${escapeHtml(voucher.promo_code)}</span></div>`).join("")
      : '<div class="empty-state">Покупок пока нет. Ваш первый ваучер появится здесь.</div>';
  } else toast(`Не удалось загрузить ваучеры: ${voucherResult.reason.message}`, true);
}

async function refreshData(showErrors = true) {
  if (!supabase) {
    if (showErrors) toast("Настройте Supabase в файле supabase.js, чтобы включить данные.", true);
    renderProfile();
    return;
  }
  const results = await Promise.allSettled([getTasks(), getDashboardStats(), getLeaderboard()]);
  if (results[0].status === "fulfilled") {
    tasks = results[0].value;
    renderTasks();
  } else if (showErrors) toast(`Не удалось загрузить задачи: ${results[0].reason.message}`, true);
  if (results[1].status === "fulfilled") renderStats(results[1].value);
  else if (showErrors) toast(`Не удалось загрузить статистику: ${results[1].reason.message}`, true);
  if (results[2].status === "fulfilled") renderLeaderboard(results[2].value);
  else if (showErrors) toast(`Не удалось загрузить рейтинг: ${results[2].reason.message}`, true);
  await loadProfileData();
  await loadShop();
}

function renderLeaderboard(people) {
  byId("leaderboard-body").innerHTML = people.length ? people.map((person, index) => `
    <tr><td>${index < 3 ? ["🥇", "🥈", "🥉"][index] : index + 1}</td><td><span class="leader-name"><span class="leader-avatar">🌱</span>${escapeHtml(person.full_name || "Участник")}</span></td><td>${formatNumber(person.completed_tasks)}</td><td>${formatNumber(person.rating)}</td></tr>`).join("")
    : '<tr><td colspan="4" class="empty-state">Лидеры появятся после первых уборок.</td></tr>';
}

async function loadShop() {
  if (!supabase) return;
  try {
    const items = await getShopItems();
    byId("shop-list").innerHTML = items.length ? items.map((item) => `
      <article class="panel shop-card"><span class="item-icon">${escapeHtml(item.icon)}</span><span class="partner-name">${escapeHtml(item.partner_name)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p><div class="shop-card-footer"><strong class="shop-price">🪙 ${formatNumber(item.price_mghc)} MGHC</strong><button class="button button-secondary" data-action="buy" data-id="${escapeHtml(item.id)}">Обменять</button></div></article>`).join("")
      : '<div class="panel empty-state">Партнёрские предложения скоро появятся.</div>';
  } catch (error) {
    byId("shop-list").innerHTML = `<div class="panel empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function enterAccount() {
  try {
    const initData = window.Telegram?.WebApp?.initData;
    if (initData) {
      await signInWithTelegram(initData);
    } else {
      const email = window.prompt("Введите email для входа по безопасной ссылке:");
      if (!email) return;
      await signInWithEmail(email.trim());
      toast("Ссылка для входа отправлена на вашу почту.");
      return;
    }
    const result = await getSession();
    session = result.session;
    await refreshData(false);
    toast("Вы вошли в My Green House.");
  } catch (error) {
    toast(`Не удалось войти: ${error.message}`, true);
  }
}

function renderInitialState() {
  renderTasks();
  renderProfile();
  byId("shop-list").innerHTML = '<div class="panel empty-state">Настройте Supabase для загрузки магазина.</div>';
  byId("transaction-list").innerHTML = '<div class="empty-state">Войдите, чтобы увидеть историю баланса.</div>';
  byId("voucher-list").innerHTML = '<div class="empty-state">Войдите, чтобы увидеть свои ваучеры.</div>';
}

function setupEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => goTo(button.dataset.view)));
  document.querySelectorAll("[data-goto]").forEach((button) => button.addEventListener("click", () => goTo(button.dataset.goto)));
  byId("profile-shortcut").addEventListener("click", () => goTo("profile"));
  byId("task-search").addEventListener("input", renderTasks);
  byId("category-filter").addEventListener("change", renderTasks);
  byId("status-filter").addEventListener("change", renderTasks);
  byId("report-category").addEventListener("change", (event) => {
    byId("recommended-reward").textContent = `${categories[event.target.value].reward} MGHC`;
  });
  byId("before-photo").addEventListener("change", (event) => {
    if (event.target.files?.[0]) byId("photo-label").textContent = event.target.files[0].name;
  });
  byId("locate-button").addEventListener("click", () => {
    if (!navigator.geolocation) {
      toast("В этом браузере нет поддержки геолокации.", true);
      return;
    }
    navigator.geolocation.getCurrentPosition((position) => {
      const { latitude, longitude } = position.coords;
      selectLocation(latitude, longitude);
      reportMap.flyTo([latitude, longitude], 16, { duration: 1.1 });
      toast("Местоположение определено.");
    }, (error) => {
      const message = error.code === 1 ? "Разрешите доступ к геолокации в настройках браузера."
        : error.code === 2 ? "Не удалось определить местоположение." : "Истекло время ожидания GPS.";
      toast(message, true);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
  byId("report-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!session?.user?.id) {
      toast("Войдите через Telegram, чтобы опубликовать задачу.", true);
      goTo("profile");
      return;
    }
    if (!selectedLocation) {
      toast("Выберите точку на карте или воспользуйтесь GPS.", true);
      return;
    }
    const form = event.currentTarget;
    const submit = byId("report-submit");
    const data = new FormData(form);
    submit.disabled = true;
    submit.textContent = "Публикуем…";
    try {
      await createTask({
        title: String(data.get("title")).trim(),
        description: String(data.get("description") || "").trim(),
        category: String(data.get("category")),
        lat: selectedLocation.lat,
        lng: selectedLocation.lng,
        reward_mghc: categories[String(data.get("category"))].reward
      }, data.get("photo"), session.user.id);
      form.reset();
      selectedLocation = null;
      if (reportMarker) reportMarker.remove();
      byId("selected-location").textContent = "Нажмите на карту или определите местоположение.";
      byId("photo-label").textContent = "Добавить фото места";
      byId("recommended-reward").textContent = "25 MGHC";
      toast("Задача опубликована. Спасибо, что заботитесь о городе!");
      await refreshData(false);
      goTo("tasks");
    } catch (error) {
      toast(`Не удалось опубликовать задачу: ${error.message}`, true);
    } finally {
      submit.disabled = false;
      submit.textContent = "Опубликовать задачу";
    }
  });
  byId("task-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const task = tasks.find((item) => item.id === button.dataset.id);
    if (!task) return;
    if (button.dataset.action === "locate") {
      goTo("tasks");
      taskMap.flyTo([task.lat, task.lng], 16, { duration: 1.1 });
      mapMarkers.find((marker) => marker.taskId === task.id)?.openPopup();
      return;
    }
    if (!session?.user?.id) {
      toast("Войдите через Telegram, чтобы принять задачу.", true);
      goTo("profile");
      return;
    }
    if (button.dataset.action === "claim") {
      button.disabled = true;
      try {
        await claimTask(task.id);
        toast("Задача закреплена за вами. После уборки добавьте фото «ПОСЛЕ».");
        await refreshData(false);
      } catch (error) {
        toast(`Не удалось взять задачу: ${error.message}`, true);
      }
    } else if (button.dataset.action === "approve") {
      button.disabled = true;
      try {
        await approveTask(task.id);
        toast(`Уборка подтверждена. Волонтёру начислено ${formatNumber(task.reward_mghc)} MGHC.`);
        await refreshData(false);
      } catch (error) {
        toast(`Не удалось подтвердить задачу: ${error.message}`, true);
        button.disabled = false;
      }
    }
  });
  byId("task-list").addEventListener("change", async (event) => {
    const input = event.target.closest(".after-photo");
    if (!input || !input.files?.[0]) return;
    input.disabled = true;
    try {
      await submitTask(input.dataset.id, input.files[0], session.user.id);
      toast("Фотоотчёт отправлен модератору.");
      await refreshData(false);
    } catch (error) {
      toast(`Не удалось отправить фотоотчёт: ${error.message}`, true);
      input.disabled = false;
    }
  });
  byId("shop-list").addEventListener("click", async (event) => {
    const button = event.target.closest('[data-action="buy"]');
    if (!button) return;
    if (!session?.user?.id) {
      toast("Войдите в аккаунт, чтобы обменять MGHC на ваучер.", true);
      goTo("profile");
      return;
    }
    button.disabled = true;
    try {
      const voucher = await buyItem(button.dataset.id);
      toast(`Покупка успешна! Промокод ${voucher.promo_code} сохранён в профиле.`);
      await refreshData(false);
    } catch (error) {
      toast(`Не удалось оформить покупку: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  });
  byId("sign-in-button").addEventListener("click", enterAccount);
  byId("sign-out-button").addEventListener("click", async () => {
    try {
      await signOut();
      session = null;
      profile = null;
      await refreshData(false);
      toast("Вы вышли из аккаунта.");
    } catch (error) {
      toast(`Не удалось выйти: ${error.message}`, true);
    }
  });
  byId("edit-name-button").addEventListener("click", async () => {
    if (!profile) return;
    const name = window.prompt("Как к вам обращаться?", profile.full_name);
    if (!name || !name.trim() || name.trim() === profile.full_name) return;
    try {
      profile = await updateName(session.user.id, name.trim().slice(0, 80));
      renderProfile();
      toast("Имя профиля обновлено.");
    } catch (error) {
      toast(`Не удалось обновить имя: ${error.message}`, true);
    }
  });
}

async function start() {
  setTheme();
  initMaps();
  setupEvents();
  renderInitialState();
  if (!supabase) {
    toast("Добавьте параметры Supabase в supabase.js для запуска платформы.", true);
    return;
  }
  try {
    const result = await getSession();
    session = result.session;
    await refreshData();
    onAuthChange((_event, nextSession) => {
      session = nextSession;
      void refreshData(false);
    });
    refreshTimer = window.setInterval(() => void refreshData(false), 60000);
  } catch (error) {
    toast(`Не удалось подключиться к Supabase: ${error.message}`, true);
  }
}

window.addEventListener("pagehide", () => window.clearInterval(refreshTimer));
start();
