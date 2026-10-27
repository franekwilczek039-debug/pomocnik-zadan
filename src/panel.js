import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, ApiError as GeminiApiError } from '@google/genai';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/* =========================================================
   Pomocnik Zadań AI — panel boczny
   Trzy silniki: Gemini (darmowy klucz), Chrome AI (lokalnie), Claude (płatny)
   ========================================================= */

const MAX_PAGE_CHARS = 200_000;
const CHROME_MAX_PAGE_CHARS = 12_000; // mały model lokalny ma krótkie okno kontekstu
const PRICES = { // USD za 1M tokenów (wejście / wyjście)
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};
// Modele Claude, dla których API może samo przełączyć się na inny model, gdy filtr bezpieczeństwa odmówi.
const SERVER_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
const ENGINE_LABEL = { gemini: 'Gemini', chrome: 'Chrome AI', claude: 'Claude' };

const SYSTEM = `Jesteś pomocnikiem, który rozwiązuje zadania znalezione na stronach internetowych (szkolne zadania, ćwiczenia, testy, pytania z platform e-learningowych itp.).

Dostajesz tekst strony (czasem tylko zaznaczony fragment) i czasem zrzut ekranu. Strona zawiera też menu, stopki, reklamy i inne elementy — pomiń je i znajdź właściwe polecenie.

Jak pracujesz:
1. Ustal dokładnie, co trzeba zrobić: polecenie, dane, oczekiwany format odpowiedzi (wybór A/B/C/D, prawda/fałsz, uzupełnienie luk, obliczenia, tłumaczenie, wypracowanie, kod itd.). Jeśli zadań jest kilka, rozwiąż wszystkie po kolei.
2. Rozwiąż poprawnie. Przy obliczeniach i faktach sprawdź wynik, zanim go podasz. Trzymaj się wymagań z polecenia (liczba słów, forma, jednostki, zaokrąglenia).
3. Pisz w języku polecenia (zwykle po polsku), na poziomie odpowiednim dla zadania.

Format odpowiedzi:
- Najpierw gotowa odpowiedź do wklejenia, w znacznikach <odpowiedz> i </odpowiedz>. W środku sam czysty tekst bez Markdownu (bez **, #, tabel), tak żeby dało się go od razu wkleić do zwykłego pola na stronie. Wzory zapisuj zwykłymi znakami (x², √2, ½, ·, ≤, π). Przy kilku zadaniach numeruj odpowiedzi tak jak na stronie. Przy pytaniach zamkniętych podaj literę i treść wybranej odpowiedzi.
- Potem, jeśli tryb to „z wyjaśnieniem”, krótkie wyjaśnienie krok po kroku w Markdownie (poza znacznikami), żeby dało się zrozumieć rozwiązanie.
- W trybie „tylko wynik” nie pisz nic poza blokiem <odpowiedz>.

Jeśli na stronie nie ma żadnego zadania, treść jest ucięta albo brakuje danych (np. rysunku), napisz to wprost w bloku <odpowiedz> i powiedz, co zaznaczyć lub włączyć (np. zrzut ekranu) — nie zgaduj.

W kolejnych wiadomościach użytkownik może dopytać o rozwiązanie. Wtedy odpowiadaj normalnie; blok <odpowiedz> dodaj tylko wtedy, gdy zmieniasz gotową odpowiedź.`;

// Gemini Nano oficjalnie nie obsługuje polskiego, więc instrukcja dla niego jest po angielsku.
const SYSTEM_CHROME = `You solve tasks found on web pages (school exercises, quizzes, tests). You get the page text, sometimes only a selected fragment. Ignore menus, footers and ads; find the actual task.

Solve every task correctly and check calculations. Answer in the language of the task.

Output format:
- First the final answer to paste, between <odpowiedz> and </odpowiedz>. Plain text only, no Markdown. Number answers like on the page. For multiple choice give the letter and the option text.
- Then, if the mode is "explain", a short step-by-step explanation.
- In "answer only" mode write nothing except the <odpowiedz> block.

If there is no task or data is missing, say so inside <odpowiedz> instead of guessing.`;

const $ = (id) => document.getElementById(id);
const state = {
  settings: {
    provider: 'gemini',
    geminiKey: '', geminiModel: 'gemini-3.8-flash',
    apiKey: '', model: 'claude-opus-5-5', effort: 'high',
  },
  conv: null,        // bieżąca rozmowa: { provider, ...dane silnika }
  abort: null,       // AbortController bieżącego zapytania
  answer: '',
  costUSD: 0,
};

/* ---------- Ustawienia ---------- */
async function loadSettings() {
  const s = await chrome.storage.local.get(Object.keys(state.settings));
  // Starsza wersja miała tylko klucz Claude — wtedy zostajemy przy Claude.
  if (!s.provider && s.apiKey) s.provider = 'claude';
  Object.assign(state.settings, Object.fromEntries(Object.entries(s).filter(([, v]) => v)));
  for (const k of Object.keys(state.settings)) $(k).value = state.settings[k];
  showProviderFields();
  updateEngineName();
  if (state.settings.provider !== 'chrome' && !currentKey()) $('settings').hidden = false;
}

function currentKey() {
  const s = state.settings;
  return s.provider === 'gemini' ? s.geminiKey : s.provider === 'claude' ? s.apiKey : 'local';
}

function showProviderFields() {
  const p = $('provider').value;
  document.querySelectorAll('[data-provider]').forEach((el) => { el.hidden = el.dataset.provider !== p; });
}

function updateEngineName() {
  $('engineName').textContent = ENGINE_LABEL[state.settings.provider];
}

async function saveSettings() {
  const next = Object.fromEntries(Object.keys(state.settings).map((k) => [k, $(k).value.trim()]));
  if (next.apiKey && !next.apiKey.startsWith('sk-ant-')) {
    showStatus('Klucz Claude powinien zaczynać się od „sk-ant-”.', 'error');
    return;
  }
  if (next.provider === 'gemini' && !next.geminiKey) {
    showStatus('Wklej klucz Gemini (darmowy, z aistudio.google.com/apikey).', 'error');
    return;
  }
  if (next.provider === 'claude' && !next.apiKey) {
    showStatus('Wklej klucz Claude albo wybierz darmowy silnik.', 'error');
    return;
  }
  state.settings = next;
  await chrome.storage.local.set(next);
  $('settings').hidden = true;
  updateEngineName();
  showStatus('Zapisano ustawienia.');
  setTimeout(hideStatus, 1500);
}

async function forgetKeys() {
  await chrome.storage.local.remove(['apiKey', 'geminiKey']);
  state.settings.apiKey = state.settings.geminiKey = '';
  $('apiKey').value = $('geminiKey').value = '';
  showStatus('Klucze usunięte z przeglądarki.');
}

/* ---------- Status ---------- */
function showStatus(msg, kind = '') {
  const el = $('status');
  el.hidden = false;
  el.className = 'status' + (kind ? ` ${kind}` : '');
  el.innerHTML = (kind === 'busy' ? '<span class="spin"></span>' : '') + '<span></span>';
  el.lastChild.textContent = msg;
}
function hideStatus() { $('status').hidden = true; }

/* ---------- Odczyt strony ---------- */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) throw new Error('Nie znalazłem otwartej karty.');
  if (/^(chrome|edge|about|chrome-extension|devtools):/.test(tab.url || '')) {
    throw new Error('Na stronach przeglądarki (chrome://…) wtyczka nie działa. Otwórz stronę z zadaniem.');
  }
  return tab;
}

// Ta funkcja wykonuje się w każdej ramce strony.
function readFrame() {
  const sel = String(window.getSelection ? window.getSelection() : '').trim();
  const text = document.body ? document.body.innerText : '';
  return { sel, text, title: document.title, url: location.href };
}

async function readPage(tab) {
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: readFrame });
  } catch (e) {
    throw new Error('Nie mogę odczytać tej strony (' + e.message + '). Spróbuj odświeżyć stronę.');
  }
  const frames = results.map((r) => r.result).filter(Boolean);
  const selected = frames.map((f) => f.sel).filter(Boolean).join('\n\n');
  const main = frames[0] || { title: tab.title, url: tab.url };
  const body = selected || frames.map((f) => f.text.trim()).filter(Boolean).join('\n\n--- ramka ---\n\n');
  return { title: main.title, url: main.url, selected: Boolean(selected), body };
}

async function screenshot(tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/* ---------- Wstawianie odpowiedzi na stronę ---------- */
function insertIntoFocused(text) {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  const editable = el.isContentEditable ||
    (el.tagName === 'TEXTAREA') ||
    (el.tagName === 'INPUT' && /^(text|search|email|url|number|tel|)$/i.test(el.type));
  if (!editable) return false;
  el.focus();
  if (document.execCommand && document.execCommand('insertText', false, text)) return true;
  if (el.isContentEditable) { el.textContent += text; return true; }
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  setter.call(el, el.value + text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

async function insertAnswer() {
  if (!state.answer) return;
  try {
    const tab = await activeTab();
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, func: insertIntoFocused, args: [state.answer],
    });
    if (res.some((r) => r.result)) flash($('insertBtn'), '✓ Wstawiono');
    else showStatus('Kliknij najpierw w pole na stronie, do którego ma trafić odpowiedź, a potem „Wstaw w pole”.', 'error');
  } catch (e) {
    showStatus(e.message, 'error');
  }
}

async function copyAnswer() {
  if (!state.answer) return;
  await navigator.clipboard.writeText(state.answer);
  flash($('copyBtn'), '✓ Skopiowano');
}

function flash(btn, label) {
  const old = btn.textContent;
  btn.textContent = label;
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1500);
}

/* ---------- Wyświetlanie ---------- */
function splitReply(text) {
  const open = text.indexOf('<odpowiedz>');
  if (open === -1) return { answer: null, explain: text };
  const close = text.indexOf('</odpowiedz>', open);
  const answer = text.slice(open + 11, close === -1 ? undefined : close).trim();
  const explain = (text.slice(0, open) + (close === -1 ? '' : text.slice(close + 12))).trim();
  return { answer, explain };
}

// Strumień przychodzi szybciej niż odświeżanie ekranu, więc rysujemy najnowszy tekst raz na klatkę.
let pending = null;
function renderReply(text, isFirst) {
  const queued = pending !== null;
  pending = { text, isFirst };
  if (queued) return;
  requestAnimationFrame(() => {
    ({ text, isFirst } = pending);
    pending = null;
    const { answer, explain } = splitReply(text);
    if (answer !== null) state.answer = answer;
    else if (isFirst && !text.includes('<')) state.answer = explain; // model pominął znaczniki
    $('answer').textContent = state.answer || '…';
    const showExplain = explain && !(isFirst && answer === null);
    $('explainCard').hidden = !showExplain;
    if (showExplain) $('explain').innerHTML = DOMPurify.sanitize(marked.parse(explain));
    $('result').hidden = false;
  });
}

function addClaudeCost(usage, model) {
  const [pin, pout] = PRICES[model] || PRICES['claude-opus-5-5'];
  const inTok = (usage.input_tokens || 0) + 1.25 * (usage.cache_creation_input_tokens || 0) + 0.1 * (usage.cache_read_input_tokens || 0);
  state.costUSD += (inTok * pin + (usage.output_tokens || 0) * pout) / 1e6;
  $('usage').textContent = `Szacowany koszt tej rozmowy: ~$${state.costUSD.toFixed(3)} (${model})`;
}

const wasAborted = () => Boolean(state.abort?.signal.aborted);

/* ---------- Silnik: Claude ---------- */
const claudeEngine = {
  start() { return { messages: [] }; },

  async send(conv, input, h) {
    const { apiKey, model, effort } = state.settings;
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const content = input.image
      ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.image } }, { type: 'text', text: input.text }]
      : input.text;
    const messages = [...conv.messages, { role: 'user', content }];
    const params = {
      model,
      max_tokens: 64000,
      system: SYSTEM,
      cache_control: { type: 'ephemeral' },
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort },
      messages,
    };
    if (SERVER_FALLBACK.has(model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    const stream = client.beta.messages.stream(params, { signal: h.signal });
    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'thinking_delta') h.onThought(event.delta.thinking);
      else if (event.delta.type === 'text_delta') h.onText(event.delta.text);
    }
    const msg = await stream.finalMessage();
    addClaudeCost(msg.usage, model);
    if (msg.stop_reason === 'refusal') {
      throw new Error('Model odmówił odpowiedzi na to zadanie. Spróbuj zaznaczyć tylko samo polecenie albo użyć innego silnika.');
    }
    // Historię zapisujemy dopiero po udanej odpowiedzi, z pełną treścią odpowiedzi modelu.
    conv.messages = [...messages, { role: 'assistant', content: msg.content }];
    return { truncated: msg.stop_reason === 'max_tokens' };
  },

  errorText(err) {
    if (err instanceof Anthropic.APIUserAbortError) return 'Zatrzymano.';
    if (err instanceof Anthropic.AuthenticationError) return 'Nieprawidłowy klucz Claude. Sprawdź go w ustawieniach (⚙️).';
    if (err instanceof Anthropic.PermissionDeniedError) return 'Ten klucz Claude nie ma dostępu do wybranego modelu.';
    if (err instanceof Anthropic.RateLimitError) return 'Za dużo zapytań naraz — odczekaj chwilę i spróbuj ponownie.';
    if (err instanceof Anthropic.BadRequestError) return 'Błąd zapytania: ' + (err.error?.error?.message || err.message);
    if (err instanceof Anthropic.InternalServerError) return 'Serwer Claude jest chwilowo przeciążony. Spróbuj za moment.';
    if (err instanceof Anthropic.APIConnectionError) return 'Brak połączenia z serwerem. Sprawdź internet.';
    if (err instanceof Anthropic.APIError) return `Błąd API Claude (${err.status}): ${err.message}`;
    return null;
  },
};

/* ---------- Silnik: Gemini (Google) ---------- */
const geminiEngine = {
  start() { return { contents: [] }; },

  async send(conv, input, h) {
    const { geminiKey, geminiModel } = state.settings;
    const ai = new GoogleGenAI({ apiKey: geminiKey });
    const parts = [];
    if (input.image) parts.push({ inlineData: { mimeType: 'image/jpeg', data: input.image } });
    parts.push({ text: input.text });
    const contents = [...conv.contents, { role: 'user', parts }];

    const stream = await ai.models.generateContentStream({
      model: geminiModel,
      contents,
      config: {
        systemInstruction: SYSTEM,
        thinkingConfig: { includeThoughts: true },
        abortSignal: h.signal,
      },
    });
    let text = '', finish = null, blocked = null;
    for await (const chunk of stream) {
      if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason;
      const cand = chunk.candidates?.[0];
      if (!cand) continue;
      if (cand.finishReason) finish = cand.finishReason;
      for (const part of cand.content?.parts || []) {
        if (!part.text) continue;
        if (part.thought) h.onThought(part.text);
        else { text += part.text; h.onText(part.text); }
      }
    }
    if (blocked || (!text && finish && finish !== 'STOP' && finish !== 'MAX_TOKENS')) {
      throw new Error('Gemini odmówił odpowiedzi na to zadanie (' + (blocked || finish) + '). Spróbuj zaznaczyć tylko samo polecenie.');
    }
    conv.contents = [...contents, { role: 'model', parts: [{ text }] }];
    $('usage').textContent = `Silnik: ${geminiModel} (darmowy limit Google)`;
    return { truncated: finish === 'MAX_TOKENS' };
  },

  errorText(err) {
    if (wasAborted()) return 'Zatrzymano.';
    if (!(err instanceof GeminiApiError)) return null;
    const msg = String(err.message || '');
    if (err.status === 400 && /API_KEY_INVALID|API key not valid/i.test(msg)) return 'Nieprawidłowy klucz Gemini. Sprawdź go w ustawieniach (⚙️).';
    if (err.status === 403) return 'Klucz Gemini nie ma dostępu do tego modelu. Utwórz nowy klucz na aistudio.google.com/apikey.';
    if (err.status === 404) return 'Ten model Gemini nie jest dostępny. Wybierz inny model w ustawieniach.';
    if (err.status === 429) return 'Wykorzystano darmowy limit Gemini. Odczekaj chwilę (albo do jutra) lub wybierz w ustawieniach model Flash-Lite.';
    if (err.status >= 500) return 'Serwer Gemini jest chwilowo przeciążony. Spróbuj za moment.';
    return `Błąd Gemini (${err.status}): ${msg.slice(0, 300)}`;
  },
};

/* ---------- Silnik: Chrome AI (Gemini Nano na komputerze) ---------- */
function chromeOptions(withImage) {
  const expectedInputs = [{ type: 'text', languages: ['en'] }];
  if (withImage) expectedInputs.push({ type: 'image' });
  return { expectedInputs, expectedOutputs: [{ type: 'text', languages: ['en'] }] };
}

async function chromeAvailability(withImage) {
  if (!('LanguageModel' in self)) return 'missing';
  try { return await LanguageModel.availability(chromeOptions(withImage)); } catch { return 'unavailable'; }
}

function chromeCreate(withImage, onProgress) {
  return LanguageModel.create({
    ...chromeOptions(withImage),
    initialPrompts: [{ role: 'system', content: SYSTEM_CHROME }],
    monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress(e.loaded)); },
  });
}

const CHROME_HELP = {
  missing: 'Ta przeglądarka nie ma wbudowanego AI. Potrzebny jest aktualny Chrome na komputerze (Windows, macOS, Linux lub Chromebook Plus).',
  unavailable: 'Chrome AI nie działa na tym komputerze (za mało miejsca, pamięci lub za słaba karta graficzna). Wybierz w ustawieniach silnik Gemini — też jest darmowy.',
};

async function checkChromeModel() {
  const out = $('chromeStatus');
  const av = await chromeAvailability(false);
  if (CHROME_HELP[av]) { out.textContent = CHROME_HELP[av]; return; }
  if (av === 'available') { out.textContent = '✓ Model jest pobrany i gotowy.'; return; }
  out.textContent = 'Pobieram model (kilka GB, może potrwać kilkanaście minut)… 0%';
  try {
    const s = await chromeCreate(false, (p) => { out.textContent = `Pobieram model… ${Math.round(p * 100)}%`; });
    s.destroy();
    out.textContent = '✓ Model jest pobrany i gotowy.';
  } catch (e) {
    out.textContent = 'Nie udało się pobrać modelu: ' + e.message;
  }
}

const chromeEngine = {
  start() { return { session: null }; },

  async send(conv, input, h) {
    if (!conv.session) {
      const av = await chromeAvailability(Boolean(input.image));
      if (CHROME_HELP[av]) throw new Error(CHROME_HELP[av]);
      conv.session = await chromeCreate(Boolean(input.image), (p) => h.onThought(`Pobieram model Chrome AI… ${Math.round(p * 100)}%`));
    }
    const prompt = input.image
      ? [{ role: 'user', content: [{ type: 'image', value: base64ToBlob(input.image, 'image/jpeg') }, { type: 'text', value: input.text }] }]
      : input.text;
    let text = '';
    for await (const chunk of conv.session.promptStreaming(prompt, { signal: h.signal })) {
      // Starsze wersje Chrome zwracały cały dotychczasowy tekst, nowsze — tylko przyrost.
      const delta = text && chunk.startsWith(text) ? chunk.slice(text.length) : chunk;
      text += delta;
      h.onText(delta);
    }
    $('usage').textContent = 'Silnik: Chrome AI (za darmo, na tym komputerze)';
    return { truncated: false };
  },

  errorText(err) {
    if (err?.name === 'AbortError' || wasAborted()) return 'Zatrzymano.';
    if (err?.name === 'NotSupportedError') return 'Chrome AI nie obsługuje tego rodzaju danych (np. zrzutu ekranu) na tym komputerze. Wyłącz zrzut ekranu albo wybierz silnik Gemini.';
    if (err?.name === 'QuotaExceededError') return 'Zadanie jest za długie dla Chrome AI. Zaznacz myszką tylko samo polecenie.';
    if (err?.name === 'NotAllowedError') return 'Chrome nie pozwolił uruchomić modelu. Kliknij przycisk jeszcze raz.';
    return null;
  },
};

const ENGINES = { claude: claudeEngine, gemini: geminiEngine, chrome: chromeEngine };

/* ---------- Rozmowa ---------- */
function setBusy(busy) {
  $('solveBtn').hidden = busy;
  $('stopBtn').hidden = !busy;
  $('followBtn').disabled = busy;
}

async function ask(input, isFirst) {
  const conv = state.conv;
  const engine = ENGINES[conv.provider];
  state.abort = new AbortController();
  setBusy(true);
  showStatus('Czytam zadanie…', 'busy');
  let text = '', thought = '';
  try {
    const res = await engine.send(conv, input, {
      signal: state.abort.signal,
      onThought(t) {
        thought = (thought + t).slice(-400);
        const line = thought.replace(/\s+/g, ' ').trim();
        if (line) showStatus((line.startsWith('Pobieram') ? '' : 'Myślę: ') + line.slice(-160), 'busy');
      },
      onText(t) {
        if (!text) showStatus('Piszę rozwiązanie…', 'busy');
        text += t;
        renderReply(text, isFirst);
      },
    });
    renderReply(text, isFirst);
    if (res.truncated) showStatus('Odpowiedź została ucięta (za długa). Dopytaj „kontynuuj”.', 'error');
    else hideStatus();
  } catch (err) {
    showStatus(engine.errorText(err) || err.message || String(err), 'error');
  } finally {
    state.abort = null;
    setBusy(false);
  }
}

async function solve() {
  hideStatus();
  const provider = state.settings.provider;
  if (provider !== 'chrome' && !currentKey()) {
    $('settings').hidden = false;
    showStatus('Najpierw wpisz klucz API w ustawieniach (dla Gemini jest darmowy).', 'error');
    return;
  }
  try {
    const tab = await activeTab();
    showStatus('Czytam stronę…', 'busy');
    const page = await readPage(tab);
    if (!page.body) throw new Error('Na tej stronie nie ma tekstu. Włącz „Dołącz zrzut ekranu” albo zaznacz zadanie.');
    const limit = provider === 'chrome' ? CHROME_MAX_PAGE_CHARS : MAX_PAGE_CHARS;
    if (page.body.length > limit) {
      throw new Error(`Tekst strony jest za długi dla tego silnika (${page.body.length.toLocaleString('pl-PL')} znaków). Zaznacz myszką tylko fragment z zadaniem i spróbuj ponownie.`);
    }
    const image = $('useShot').checked ? await screenshot(tab) : null;
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const extra = $('extra').value.trim();
    const text = `Strona: ${page.title}\nAdres: ${page.url}\n\n` +
      (page.selected ? 'Użytkownik zaznaczył ten fragment — to jest zadanie:\n' : 'Pełny tekst strony:\n') +
      `<strona>\n${page.body}\n</strona>\n\n` +
      (image ? 'Dołączony jest też zrzut widocznej części strony.\n' : '') +
      `Tryb: ${mode === 'explain' ? 'z wyjaśnieniem (explain)' : 'tylko wynik (answer only)'}` +
      (extra ? `\nDodatkowa wskazówka użytkownika: ${extra}` : '');

    state.conv?.session?.destroy?.();
    state.conv = { provider, ...ENGINES[provider].start() };
    state.answer = '';
    state.costUSD = 0;
    $('answer').textContent = '…';
    $('explainCard').hidden = true;
    $('usage').textContent = '';
    await ask({ text, image }, true);
  } catch (e) {
    setBusy(false);
    showStatus(e.message, 'error');
  }
}

async function followUp() {
  const q = $('followup').value.trim();
  if (!q || state.abort) return;
  if (!state.conv) { showStatus('Najpierw rozwiąż zadanie.', 'error'); return; }
  $('followup').value = '';
  await ask({ text: q, image: null }, false);
}

/* ---------- Zdarzenia ---------- */
$('settingsBtn').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
$('provider').addEventListener('change', showProviderFields);
$('chromeCheck').addEventListener('click', checkChromeModel);
$('saveSettings').addEventListener('click', saveSettings);
$('forgetKey').addEventListener('click', forgetKeys);
$('solveBtn').addEventListener('click', solve);
$('stopBtn').addEventListener('click', () => state.abort && state.abort.abort());
$('copyBtn').addEventListener('click', copyAnswer);
$('insertBtn').addEventListener('click', insertAnswer);
$('followBtn').addEventListener('click', followUp);
$('followup').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); followUp(); }
});

loadSettings();
