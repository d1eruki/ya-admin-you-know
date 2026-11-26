<!-- Вход и редактор черновиков сайтов с публикацией. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

type Field = {
  key: string;
  label: string;
  section: string;
  group: string;
  type: "text" | "image";
  value: string;
};
type Publication = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  message: string;
};

type Content = {
  fields: Field[];
  draft: Record<string, string>;
  revision: string;
  publication: Publication | null;
  publishingEnabled: boolean;
  mediaEnabled: boolean;
  needsBaseline: boolean;
};

type Site = { domain: string; name?: string; url?: string };
type Session = { site: Site | null };
type VerifiedSession = { site: Site; token: string };
type Challenge = { challengeId: string };

const apiBase =
  import.meta.env.VITE_API_URL?.trim().replace(/\/+$/, "") ||
  (import.meta.env.DEV ? "http://127.0.0.1:8787" : "");
const sessionStorageKey = "ya-admin-you-know:session";
const sessionToken = ref(sessionStorage.getItem(sessionStorageKey) ?? "");
const site = ref<Site | null>(null);
const domain = ref("");
const requestedDomain = ref("");
const challengeId = ref("");
const code = ref("");
const authState = ref<"domain" | "code">("domain");
const authPending = ref(false);
const authError = ref("");
const domainInput = ref<HTMLInputElement>();
const codeInput = ref<HTMLInputElement>();
const siteUrl = computed(() => {
  if (!site.value) return "";
  try {
    const url = new URL(site.value.url ?? `https://${site.value.domain}`);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : "";
  } catch {
    return "";
  }
});
const fields = ref<Field[]>([]);
const revision = ref("");
const values = ref<Record<string, string>>({});
const saved = ref<Record<string, string>>({});
const selection = ref<{ section: string; group: string }>();
const expanded = ref(new Set<string>());
const query = ref("");
const navigationOpen = ref(false);
const loading = ref(true);
const pending = ref(false);
const error = ref("");
const notice = ref("");
const publication = ref<Publication | null>(null);
const publishingEnabled = ref(false);
const mediaEnabled = ref(false);
const needsBaseline = ref(false);
const publishDialog = ref<HTMLDialogElement>();
const publishReviewOpen = ref(false);
const publishing = computed(
  () =>
    publication.value?.status === "queued" ||
    publication.value?.status === "running",
);
const editorLocked = computed(() => pending.value || publishing.value);
const previewUrls = ref<Record<string, string>>({});
const previewRequests = new Set<string>();
let publicationTimer: ReturnType<typeof setTimeout> | undefined;
let editorGeneration = 0;

const sections = computed(() => {
  const result = new Map<string, Map<string, Field[]>>();
  for (const field of fields.value) {
    const groups = result.get(field.section) ?? new Map<string, Field[]>();
    result.set(field.section, groups);
    const members = groups.get(field.group) ?? [];
    groups.set(field.group, members);
    members.push(field);
  }
  return result;
});

const searchResults = computed(() => {
  const search = query.value.trim().toLocaleLowerCase("ru");
  if (!search) return [];
  return fields.value.filter((field) =>
    [
      field.section,
      field.group,
      field.label,
      field.key,
      field.type === "text" ? current(field) : "",
    ]
      .join(" ")
      .toLocaleLowerCase("ru")
      .includes(search),
  );
});

const selectedFields = computed(() => {
  const active = selection.value;
  return active
    ? (sections.value.get(active.section)?.get(active.group) ?? [])
    : [];
});
const visibleText = computed(() =>
  selectedFields.value.filter((field) => field.type === "text"),
);
const visibleImages = computed(() =>
  selectedFields.value.filter((field) => field.type === "image"),
);
const hasSavedDraft = computed(() => Object.keys(saved.value).length > 0);
const changed = computed(() =>
  fields.value.filter((field) => current(field) !== field.value),
);
const unsaved = computed(() =>
  fields.value.some(
    (field) => (saved.value[field.key] ?? field.value) !== current(field),
  ),
);
const canReviewPublication = computed(
  () =>
    publishingEnabled.value &&
    !loading.value &&
    !editorLocked.value &&
    !unsaved.value &&
    !needsBaseline.value &&
    hasSavedDraft.value &&
    changed.value.length > 0,
);
const fieldCount = new Intl.NumberFormat("ru-RU");

function current(field: Field) {
  return values.value[field.key] ?? field.value;
}

function choose(section: string, group: string) {
  selection.value = { section, group };
  expanded.value.add(section);
  query.value = "";
  navigationOpen.value = false;
}

function toggle(section: string) {
  if (expanded.value.has(section)) expanded.value.delete(section);
  else expanded.value.add(section);
}

function edit(field: Field, value: string) {
  values.value[field.key] = value;
  notice.value = "";
}

function useContent(result: Content) {
  publication.value = result.publication;
  publishingEnabled.value = result.publishingEnabled;
  mediaEnabled.value = result.mediaEnabled;
  needsBaseline.value = result.needsBaseline;
  schedulePublicationCheck();
  fields.value = result.fields;
  revision.value = result.revision;
  values.value = { ...result.draft };
  saved.value = { ...result.draft };
  const active = selection.value;
  if (active && sections.value.get(active.section)?.has(active.group)) return;
  const first = result.fields[0];
  if (first) choose(first.section, first.group);
  else selection.value = undefined;
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!apiBase) throw new Error("Сервер входа ещё не подключён.");
  let response: Response;
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (sessionToken.value)
    headers.set("Authorization", `Bearer ${sessionToken.value}`);
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...options,
      credentials: "omit",
      signal: AbortSignal.timeout(15000),
      headers,
    });
  } catch {
    throw new Error("Сервис временно недоступен. Попробуйте ещё раз.");
  }
  if (
    response.status === 401 &&
    path.startsWith("/api/content") &&
    sessionToken.value
  ) {
    await clearEditorSession();
  }
  if (response.status === 204 && response.ok) return undefined as T;
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Сервис временно недоступен. Попробуйте ещё раз.");
  }
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(
      result.error || "Не удалось выполнить действие. Попробуйте ещё раз.",
    );
  return result;
}

function normalizeSiteAddress(value: string) {
  const raw = value.trim();
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port
    )
      return "";
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return "";
    return `https://${host}${url.pathname.replace(/\/+$/, "")}/`;
  } catch {
    return "";
  }
}

async function submitLogin() {
  if (authPending.value) return;
  authError.value = "";
  const enteringDomain = authState.value === "domain";
  const address = enteringDomain
    ? normalizeSiteAddress(domain.value)
    : requestedDomain.value;
  if (!address) {
    authError.value = "Укажите адрес сайта, например example.com.";
    return;
  }
  authPending.value = true;
  try {
    if (enteringDomain) {
      const result = await api<Challenge>("/api/auth/request-code", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
      if (!result.challengeId)
        throw new Error(
          "Сервис не подтвердил отправку кода. Попробуйте ещё раз.",
        );
      requestedDomain.value = address;
      challengeId.value = result.challengeId;
      code.value = "";
      authState.value = "code";
    } else {
      const result = await api<VerifiedSession>("/api/auth/verify-code", {
        method: "POST",
        body: JSON.stringify({
          address,
          challengeId: challengeId.value,
          code: code.value,
        }),
      });
      if (!result.site || !result.token)
        throw new Error("Не удалось открыть сайт. Попробуйте ещё раз.");
      sessionToken.value = result.token;
      sessionStorage.setItem(sessionStorageKey, result.token);
      site.value = result.site;
      code.value = "";
      await load();
    }
  } catch (cause) {
    authError.value =
      cause instanceof Error ? cause.message : "Не удалось войти.";
  } finally {
    authPending.value = false;
  }
  if (!site.value && authState.value === "code") {
    await nextTick();
    codeInput.value?.focus();
  }
}

async function changeDomain() {
  authState.value = "domain";
  challengeId.value = "";
  code.value = "";
  authError.value = "";
  await nextTick();
  domainInput.value?.focus();
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    useContent(await api<Content>("/api/content"));
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось загрузить поля.";
  } finally {
    loading.value = false;
  }
}

async function saveDraft() {
  pending.value = true;
  error.value = "";
  notice.value = "";
  try {
    const edits = Object.fromEntries(
      changed.value.map((field) => [field.key, current(field)]),
    );
    const data = { edits, revision: revision.value };
    useContent(
      await api<Content>("/api/content/draft", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    );
    notice.value = "Черновик сохранён";
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Повторите действие.";
  } finally {
    pending.value = false;
  }
}

function clearPreviews() {
  editorGeneration++;
  for (const url of Object.values(previewUrls.value)) URL.revokeObjectURL(url);
  previewUrls.value = {};
  previewRequests.clear();
}

watch(
  () =>
    (publishReviewOpen.value
      ? changed.value.filter((field) => field.type === "image")
      : visibleImages.value
    )
      .map((field) => values.value[field.key])
      .filter(Boolean),
  async (ids) => {
    const generation = editorGeneration;
    const token = sessionToken.value;
    await Promise.all(
      ids.map(async (id) => {
        if (previewUrls.value[id] || previewRequests.has(id)) return;
        previewRequests.add(id);
        try {
          const response = await fetch(
            `${apiBase}/api/content/media/${encodeURIComponent(id)}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(15_000),
            },
          );
          if (!response.ok) throw new Error();
          const blob = await response.blob();
          if (generation === editorGeneration)
            previewUrls.value[id] = URL.createObjectURL(blob);
        } catch {
          if (generation === editorGeneration)
            error.value = "Не удалось открыть изображение черновика.";
        } finally {
          if (generation === editorGeneration) previewRequests.delete(id);
        }
      }),
    );
  },
);

async function replaceImage(field: Field, event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    error.value = "Размер изображения должен быть до 4 МБ.";
    return;
  }
  error.value = "";
  pending.value = true;
  try {
    const { id } = await api<{ id: string }>("/api/content/media", {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    previewUrls.value[id] = URL.createObjectURL(file);
    edit(field, id);
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : "Не удалось загрузить изображение.";
  } finally {
    pending.value = false;
  }
}

function schedulePublicationCheck() {
  clearTimeout(publicationTimer);
  if (!publishing.value) return;
  const generation = editorGeneration;
  publicationTimer = setTimeout(async () => {
    try {
      const result = await api<{ publication: Publication | null }>(
        "/api/content/publication",
      );
      if (generation !== editorGeneration) return;
      publication.value = result.publication;
      if (result.publication?.status === "succeeded") {
        await load();
        notice.value = result.publication.message;
      }
    } catch {
      // Keep checking after a transient connection failure.
    } finally {
      if (generation === editorGeneration) schedulePublicationCheck();
    }
  }, 3000);
}

function showPublishReview() {
  if (!canReviewPublication.value || !publishDialog.value) return;
  error.value = "";
  publishDialog.value.showModal();
  publishReviewOpen.value = true;
}

async function publishDraft() {
  if (!publishDialog.value?.open || !canReviewPublication.value) return;
  error.value = "";
  notice.value = "";
  pending.value = true;
  try {
    publication.value = await api<Publication>("/api/content/publish", {
      method: "POST",
      body: JSON.stringify({ revision: revision.value }),
    });
    publishDialog.value?.close();
    schedulePublicationCheck();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось начать публикацию.";
  } finally {
    pending.value = false;
  }
}

onUnmounted(() => {
  clearTimeout(publicationTimer);
  clearPreviews();
});

const revokeDialog = ref<HTMLDialogElement>();
const revokeId = ref("");
const revokeCode = ref("");
const revokeError = ref("");
const revokePending = ref(false);

function showRevokeDialog() {
  revokeId.value = "";
  revokeCode.value = "";
  revokeError.value = "";
  revokeDialog.value?.showModal();
}

async function revokeSessions() {
  revokeError.value = "";
  revokePending.value = true;
  try {
    if (!revokeId.value) {
      const result = await api<Challenge>("/api/auth/revoke/request", {
        method: "POST",
        body: "{}",
      });
      revokeId.value = result.challengeId;
    } else {
      await api("/api/auth/revoke/confirm", {
        method: "POST",
        body: JSON.stringify({
          challengeId: revokeId.value,
          code: revokeCode.value,
        }),
      });
      revokeDialog.value?.close();
      await clearEditorSession();
    }
  } catch (cause) {
    revokeError.value =
      cause instanceof Error ? cause.message : "Не удалось завершить сеансы.";
  } finally {
    revokePending.value = false;
  }
}

async function clearEditorSession() {
  sessionToken.value = "";
  sessionStorage.removeItem(sessionStorageKey);
  site.value = null;
  selection.value = undefined;
  clearTimeout(publicationTimer);
  clearPreviews();
  publication.value = null;
  fields.value = [];
  values.value = {};
  saved.value = {};
  expanded.value.clear();
  notice.value = "";
  domain.value = "";
  await changeDomain();
}

async function logout() {
  pending.value = true;
  error.value = "";
  try {
    await api("/api/auth/logout", { method: "POST" });
    await clearEditorSession();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "Не удалось завершить сеанс.";
  } finally {
    pending.value = false;
  }
}

onMounted(async () => {
  if (!apiBase || !sessionToken.value) return;
  try {
    const session = await api<Session>("/api/session");
    if (session?.site && !authPending.value && authState.value === "domain") {
      site.value = session.site;
      await load();
    } else if (!session.site) {
      sessionToken.value = "";
      sessionStorage.removeItem(sessionStorageKey);
    }
  } catch {
    // The login form is still available if the previous session cannot be restored.
  }
});
</script>

<template>
  <div v-if="!site" class="login-shell">
    <header class="login-topbar">
      <div class="identity">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="site-name">ya-admin-you-know</span>
      </div>
    </header>

    <main class="login-main" aria-labelledby="login-heading">
      <div class="login-rail" aria-hidden="true">
        <span class="rail-track"></span>
        <span
          class="rail-cursor"
          :class="{ 'at-code': authState === 'code' }"
        ></span>
      </div>
      <div class="login-panel">
        <ol class="login-steps" aria-label="Этапы входа">
          <li :aria-current="authState === 'domain' ? 'step' : undefined">
            Домен
          </li>
          <li :aria-current="authState === 'code' ? 'step' : undefined">
            Код из письма
          </li>
        </ol>
        <h1 id="login-heading">
          {{ authState === "domain" ? "Вход в админку" : "Введите код" }}
        </h1>
        <p class="login-description" v-if="authState === 'domain'">
          Укажите адрес сайта. Код для входа придёт на привязанную к нему почту.
        </p>
        <p class="login-description" v-else>
          Если сайт <strong>{{ requestedDomain }}</strong> подключён, код придёт
          на его почту.
        </p>
        <form class="login-form" @submit.prevent="submitLogin">
          <div v-if="authState === 'domain'" class="field">
            <label for="login-domain">Адрес сайта</label>
            <input
              ref="domainInput"
              id="login-domain"
              v-model="domain"
              type="text"
              inputmode="url"
              autocapitalize="off"
              spellcheck="false"
              placeholder="example.com"
              autocomplete="url"
              required
              :disabled="authPending"
              :aria-describedby="authError ? 'auth-error' : undefined"
              @input="authError = ''"
            />
          </div>
          <div v-else class="field">
            <label for="login-code">Одноразовый код</label>
            <input
              ref="codeInput"
              id="login-code"
              v-model.trim="code"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              pattern="[0-9]{6}"
              maxlength="6"
              required
              :disabled="authPending"
              :aria-describedby="authError ? 'auth-error' : undefined"
              @input="authError = ''"
            />
          </div>
          <p v-if="authError" id="auth-error" class="auth-error" role="alert">
            {{ authError }}
          </p>
          <button
            class="primary login-submit"
            type="submit"
            :disabled="authPending"
          >
            {{
              authPending
                ? authState === "domain"
                  ? "Отправляем код…"
                  : "Проверяем код…"
                : authState === "domain"
                  ? "Получить код"
                  : "Войти"
            }}
          </button>
          <button
            v-if="authState === 'code'"
            class="change-domain"
            type="button"
            :disabled="authPending"
            @click="changeDomain"
          >
            Изменить адрес
          </button>
        </form>
      </div>
    </main>
  </div>

  <div v-else class="workspace" @keydown.esc="navigationOpen = false">
    <header class="topbar">
      <div class="identity">
        <button
          class="menu-toggle secondary"
          type="button"
          :aria-expanded="navigationOpen"
          aria-controls="content-navigation"
          @click="navigationOpen = !navigationOpen"
        >
          Разделы
        </button>
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <div>
          <p class="site-name">ya-admin-you-know</p>
          <p class="site-caption">{{ site.name || site.domain }}</p>
        </div>
      </div>
      <div class="session-actions">
        <a
          v-if="siteUrl"
          class="site-link"
          :href="siteUrl"
          target="_blank"
          rel="noopener"
          >Открыть сайт</a
        >
        <button
          type="button"
          class="secondary"
          :disabled="pending || revokePending"
          @click="showRevokeDialog"
        >
          Завершить все сеансы
        </button>
        <button
          type="button"
          class="secondary"
          :disabled="pending"
          @click="logout"
        >
          Выйти
        </button>
      </div>
    </header>

    <dialog
      ref="revokeDialog"
      aria-labelledby="revoke-title"
      @cancel="revokePending && $event.preventDefault()"
    >
      <form class="auth-form" @submit.prevent="revokeSessions">
        <h2 id="revoke-title">Завершить все сеансы</h2>
        <p>После подтверждения потребуется войти снова на всех устройствах.</p>
        <label v-if="revokeId" class="field">
          Код из письма
          <input
            v-model="revokeCode"
            type="text"
            inputmode="numeric"
            pattern="[0-9]{6}"
            maxlength="6"
            autocomplete="one-time-code"
            required
          />
        </label>
        <p v-if="revokeError" role="alert">{{ revokeError }}</p>
        <div class="action-buttons">
          <button
            type="button"
            class="secondary"
            :disabled="revokePending"
            @click="revokeDialog?.close()"
          >
            Отмена
          </button>
          <button type="submit" class="primary" :disabled="revokePending">
            {{ revokeId ? "Завершить сеансы" : "Получить код" }}
          </button>
        </div>
      </form>
    </dialog>

    <dialog
      ref="publishDialog"
      class="publish-review"
      aria-labelledby="publish-review-title"
      @cancel="pending && $event.preventDefault()"
      @close="publishReviewOpen = false"
    >
      <form @submit.prevent="publishDraft">
        <h2 id="publish-review-title">Сравнение изменений</h2>
        <div class="publish-review-list" v-if="publishReviewOpen">
          <section v-for="field in changed" :key="field.key">
            <p class="breadcrumb">{{ field.section }} / {{ field.group }}</p>
            <h3>{{ field.label }}</h3>
            <div class="publish-review-values">
              <figure>
                <figcaption>Было</figcaption>
                <img
                  v-if="field.type === 'image'"
                  :src="field.value"
                  :alt="field.label"
                  loading="lazy"
                />
                <p v-else class="publish-review-text">
                  {{ field.value || "Пусто" }}
                </p>
              </figure>
              <figure>
                <figcaption>Стало</figcaption>
                <template v-if="field.type === 'image'">
                  <img
                    v-if="previewUrls[current(field)]"
                    :src="previewUrls[current(field)]"
                    :alt="field.label"
                    loading="lazy"
                  />
                  <p v-else>Новое изображение</p>
                </template>
                <p v-else class="publish-review-text">
                  {{ current(field) || "Пусто" }}
                </p>
              </figure>
            </div>
          </section>
        </div>
        <p v-if="error" class="editor-error" role="alert">{{ error }}</p>
        <div class="action-buttons">
          <button
            type="button"
            class="secondary"
            :disabled="pending"
            autofocus
            @click="publishDialog?.close()"
          >
            Назад
          </button>
          <button
            type="submit"
            class="primary"
            :disabled="!canReviewPublication"
          >
            {{ pending ? "Запускаем публикацию…" : "Опубликовать" }}
          </button>
        </div>
      </form>
    </dialog>

    <div class="workarea">
      <button
        v-if="navigationOpen"
        type="button"
        class="scrim"
        aria-label="Закрыть разделы"
        @click="navigationOpen = false"
      ></button>
      <aside
        id="content-navigation"
        class="navigation"
        :class="{ 'is-open': navigationOpen }"
        aria-label="Контент сайта"
      >
        <div class="navigation-title">
          <h2>Контент</h2>
          <span v-if="fields.length"
            >{{ fieldCount.format(fields.length) }} полей</span
          >
        </div>
        <label class="search">
          <span class="search-icon" aria-hidden="true"></span>
          <input
            v-model="query"
            type="search"
            placeholder="Найти поле"
            aria-label="Найти поле"
          />
        </label>
        <nav
          v-if="query.trim()"
          aria-label="Результаты поиска"
          class="sections"
        >
          <p v-if="searchResults.length === 0" class="no-results">
            Полей не найдено
          </p>
          <button
            v-for="field in searchResults"
            :key="field.key"
            type="button"
            class="tree-option search-result"
            @click="choose(field.section, field.group)"
          >
            <strong>{{ field.label }}</strong>
            <small>{{ field.section }} / {{ field.group }}</small>
          </button>
        </nav>
        <nav v-else class="sections" aria-label="Страницы и разделы">
          <p class="page-name">
            <span class="page-icon" aria-hidden="true"></span>Главная
          </p>
          <div
            v-for="[section, groups] in sections"
            :key="section"
            class="tree-section"
          >
            <button
              type="button"
              class="tree-heading"
              :class="{ 'active-section': selection?.section === section }"
              :aria-expanded="expanded.has(section)"
              @click="toggle(section)"
            >
              <span
                class="chevron"
                :class="{ 'is-expanded': expanded.has(section) }"
                aria-hidden="true"
              ></span>
              {{ section }}
            </button>
            <div v-if="expanded.has(section)" class="tree-groups">
              <button
                v-for="[group, groupFields] in groups"
                :key="group"
                type="button"
                class="tree-option"
                :aria-current="
                  selection?.section === section && selection.group === group
                    ? 'true'
                    : undefined
                "
                @click="choose(section, group)"
              >
                <span>{{ group }}</span>
                <small>{{ groupFields.length }}</small>
              </button>
            </div>
          </div>
        </nav>
      </aside>

      <main class="canvas" aria-labelledby="editor-title" :aria-busy="loading">
        <div v-if="loading" class="empty-panel">
          <h1 id="editor-title">Загружаем контент</h1>
        </div>
        <div v-else-if="!selection" class="empty-panel">
          <h1 id="editor-title">Контент сайта</h1>
          <p>{{ error || "У сайта пока нет доступных полей." }}</p>
          <button type="button" class="secondary" @click="load">
            Обновить
          </button>
        </div>
        <template v-else>
          <header class="editor-header">
            <p class="breadcrumb">
              Главная <span>/</span> {{ selection.section }}
            </p>
            <h1 id="editor-title">{{ selection.group }}</h1>
          </header>
          <div v-if="error" class="editor-error" role="alert">{{ error }}</div>
          <div
            class="editor"
            :class="{ 'without-media': !visibleImages.length }"
          >
            <section
              v-if="visibleText.length"
              class="text-surface"
              aria-labelledby="text-heading"
            >
              <h2 id="text-heading">Тексты</h2>
              <div v-for="field in visibleText" :key="field.key" class="field">
                <label :for="field.key">{{ field.label }}</label>
                <textarea
                  v-if="field.value.length > 86 || field.value.includes('\n')"
                  :id="field.key"
                  :value="current(field)"
                  rows="4"
                  :disabled="editorLocked"
                  @input="
                    edit(field, ($event.target as HTMLTextAreaElement).value)
                  "
                ></textarea>
                <input
                  v-else
                  :id="field.key"
                  :value="current(field)"
                  type="text"
                  :disabled="editorLocked"
                  @input="
                    edit(field, ($event.target as HTMLInputElement).value)
                  "
                />
              </div>
            </section>
            <section
              v-if="visibleImages.length"
              class="media-surface"
              aria-labelledby="media-heading"
            >
              <h2 id="media-heading">Изображения</h2>
              <div
                v-for="field in visibleImages"
                :key="field.key"
                class="media-field"
              >
                <figure>
                  <img
                    :src="previewUrls[values[field.key]] ?? field.value"
                    :alt="field.label"
                    loading="lazy"
                    decoding="async"
                  />
                </figure>
                <div class="media-tools">
                  <span>{{ field.label }}</span>
                  <label
                    v-if="mediaEnabled"
                    class="secondary upload"
                    :class="{ disabled: editorLocked }"
                  >
                    Заменить
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      :aria-label="`Заменить: ${field.label}`"
                      :disabled="editorLocked"
                      @change="replaceImage(field, $event)"
                    />
                  </label>
                  <button
                    v-if="values[field.key]"
                    type="button"
                    class="secondary"
                    :disabled="editorLocked"
                    @click="
                      delete values[field.key];
                      notice = '';
                    "
                  >
                    Вернуть исходное
                  </button>
                </div>
              </div>
            </section>
          </div>
        </template>
      </main>
    </div>

    <footer v-if="selection" class="actions">
      <p role="status">
        <span
          class="status-mark"
          :class="{ dirty: unsaved || changed.length }"
          aria-hidden="true"
        ></span>
        {{
          publishing
            ? publication?.status === "queued"
              ? "Публикация в очереди"
              : "Идёт выкладка"
            : unsaved
              ? "Есть несохранённые изменения"
              : notice ||
                publication?.message ||
                (hasSavedDraft ? "Черновик сохранён" : "Изменений пока нет")
        }}
      </p>
      <div class="action-buttons">
        <button
          type="button"
          :class="publishingEnabled ? 'secondary' : 'primary'"
          :disabled="editorLocked || (!unsaved && !needsBaseline)"
          @click="saveDraft"
        >
          Сохранить черновик
        </button>
        <button
          v-if="publishingEnabled"
          type="button"
          class="primary"
          :disabled="!canReviewPublication"
          @click="showPublishReview"
        >
          Продолжить
        </button>
      </div>
    </footer>
  </div>
</template>
