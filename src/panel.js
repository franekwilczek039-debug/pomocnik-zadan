import Anthropic from '@anthropic-ai/sdk';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/* =========================================================
   Pomocnik Zadań AI — panel boczny
   ========================================================= */

const MAX_PAGE_CHARS = 200_000;
const PRICES = { // USD za 1M tokenów (wejście / wyjście)
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};
// Modele, dla których API może samo przełączyć się na inny model, gdy filtr bezpieczeństwa odmówi.
const SERVER_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

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

const $ = (id) => document.getElementById(id);
const state = {
  settings: { apiKey: '', model: 'claude-opus-5-5', effort: 'high' },
  messages: [],
  stream: null,
  answer: '',
  costUSD: 0,
};

/* ---------- Ustawienia ---------- */
async function loadSettings() {
  const s = await chrome.storage.local.get(['apiKey', 'model', 'effort']);
  Object.assign(state.settings, Object.fromEntries(Object.entries(s).filter(([, v]) => v)));
  $('apiKey').value = state.settings.apiKey;
  $('model').value = state.settings.model;
  $('effort').value = state.settings.effort;
  if (!state.settings.apiKey) $('settings').hidden = false;
}

async function saveSettings() {
  const apiKey = $('apiKey').value.trim();
  if (apiKey && !apiKey.startsWith('sk-ant-')) {
    showStatus('Klucz API powinien zaczynać się od „sk-ant-”.', 'error');
    return;
  }
  state.settings = { apiKey, model: $('model').value, effort: $('effort').value };
  await chrome.storage.local.set(state.settings);
  $('settings').hidden = true;
  showStatus('Zapisano ustawienia.');
  setTimeout(hideStatus, 1500);
}

async function forgetKey() {
  await chrome.storage.local.remove('apiKey');
  state.settings.apiKey = '';
  $('apiKey').value = '';
  showStatus('Klucz usunięty z przeglądarki.');
}

/* ---------- Status ---------- */
function showStatus(msg, kind = '') {
  const el = $('status');
  el.hidden = false;
  el.className = 'status' + (kind ? ` ${kind}` : '');
  el.innerHTML = (kind === 'busy' ? '<span class="spin"></span>' : '') + `<span></span>`;
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

function addCost(usage, model) {
  const [pin, pout] = PRICES[model] || PRICES['claude-opus-5-5'];
  const inTok = (usage.input_tokens || 0) + 1.25 * (usage.cache_creation_input_tokens || 0) + 0.1 * (usage.cache_read_input_tokens || 0);
  state.costUSD += (inTok * pin + (usage.output_tokens || 0) * pout) / 1e6;
  $('usage').textContent = `Szacowany koszt tej rozmowy: ~$${state.costUSD.toFixed(3)} (${model})`;
}

/* ---------- Rozmowa z Claude ---------- */
function setBusy(busy) {
  $('solveBtn').hidden = busy;
  $('stopBtn').hidden = !busy;
  $('followBtn').disabled = busy;
}

async function ask(userContent, isFirst) {
  const { apiKey, model, effort } = state.settings;
  if (!apiKey) {
    $('settings').hidden = false;
    showStatus('Najpierw wpisz swój klucz API w ustawieniach.', 'error');
    return;
  }
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  state.messages.push({ role: 'user', content: userContent });

  const params = {
    model,
    max_tokens: 64000,
    system: SYSTEM,
    cache_control: { type: 'ephemeral' },
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort },
    messages: state.messages,
  };
  if (SERVER_FALLBACK.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  setBusy(true);
  showStatus('Czytam zadanie…', 'busy');
  let text = '';
  try {
    const stream = client.beta.messages.stream(params);
    state.stream = stream;
    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'thinking_delta') {
          const t = event.delta.thinking.replace(/\s+/g, ' ').trim();
          if (t) showStatus('Myślę: ' + t.slice(-160), 'busy');
        } else if (event.delta.type === 'text_delta') {
          if (!text) showStatus('Piszę rozwiązanie…', 'busy');
          text += event.delta.text;
          renderReply(text, isFirst);
        }
      }
    }
    const msg = await stream.finalMessage();
    addCost(msg.usage, model);

    if (msg.stop_reason === 'refusal') {
      state.messages.pop();
      showStatus('Model odmówił odpowiedzi na to zadanie. Spróbuj zaznaczyć tylko samo polecenie albo użyć innego modelu.', 'error');
      return;
    }
    state.messages.push({ role: 'assistant', content: msg.content });
    renderReply(text, isFirst);
    if (msg.stop_reason === 'max_tokens') showStatus('Odpowiedź została ucięta (za długa). Dopytaj „kontynuuj”.', 'error');
    else hideStatus();
  } catch (err) {
    state.messages.pop(); // nie zostawiamy w historii pytania bez odpowiedzi
    showStatus(errorText(err), 'error');
  } finally {
    state.stream = null;
    setBusy(false);
  }
}

function errorText(err) {
  if (err instanceof Anthropic.APIUserAbortError) return 'Zatrzymano.';
  if (err instanceof Anthropic.AuthenticationError) return 'Nieprawidłowy klucz API. Sprawdź go w ustawieniach (⚙️).';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Ten klucz API nie ma dostępu do wybranego modelu.';
  if (err instanceof Anthropic.RateLimitError) return 'Za dużo zapytań naraz — odczekaj chwilę i spróbuj ponownie.';
  if (err instanceof Anthropic.BadRequestError) return 'Błąd zapytania: ' + (err.error?.error?.message || err.message);
  if (err instanceof Anthropic.InternalServerError) return 'Serwer Claude jest chwilowo przeciążony. Spróbuj za moment.';
  if (err instanceof Anthropic.APIConnectionError) return 'Brak połączenia z serwerem. Sprawdź internet.';
  if (err instanceof Anthropic.APIError) return `Błąd API (${err.status}): ${err.message}`;
  return err.message || String(err);
}

async function solve() {
  hideStatus();
  try {
    const tab = await activeTab();
    showStatus('Czytam stronę…', 'busy');
    const page = await readPage(tab);
    if (!page.body) throw new Error('Na tej stronie nie ma tekstu. Włącz „Dołącz zrzut ekranu” albo zaznacz zadanie.');
    if (page.body.length > MAX_PAGE_CHARS) {
      throw new Error(`Strona jest bardzo długa (${page.body.length.toLocaleString('pl-PL')} znaków). Zaznacz myszką tylko fragment z zadaniem i spróbuj ponownie.`);
    }
    const content = [];
    if ($('useShot').checked) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await screenshot(tab) } });
    }
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const extra = $('extra').value.trim();
    content.push({
      type: 'text',
      text: `Strona: ${page.title}\nAdres: ${page.url}\n\n` +
        (page.selected ? 'Użytkownik zaznaczył ten fragment — to jest zadanie:\n' : 'Pełny tekst strony:\n') +
        `<strona>\n${page.body}\n</strona>\n\n` +
        (content.length ? 'Dołączony jest też zrzut widocznej części strony.\n' : '') +
        `Tryb: ${mode === 'explain' ? 'z wyjaśnieniem' : 'tylko wynik'}` +
        (extra ? `\nDodatkowa wskazówka użytkownika: ${extra}` : ''),
    });

    state.messages = [];
    state.answer = '';
    state.costUSD = 0;
    $('answer').textContent = '…';
    $('explainCard').hidden = true;
    $('usage').textContent = '';
    await ask(content, true);
  } catch (e) {
    setBusy(false);
    showStatus(e.message, 'error');
  }
}

async function followUp() {
  const q = $('followup').value.trim();
  if (!q || state.stream) return;
  if (!state.messages.length) { showStatus('Najpierw rozwiąż zadanie.', 'error'); return; }
  $('followup').value = '';
  await ask(q, false);
}

/* ---------- Zdarzenia ---------- */
$('settingsBtn').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
$('saveSettings').addEventListener('click', saveSettings);
$('forgetKey').addEventListener('click', forgetKey);
$('solveBtn').addEventListener('click', solve);
$('stopBtn').addEventListener('click', () => state.stream && state.stream.abort());
$('copyBtn').addEventListener('click', copyAnswer);
$('insertBtn').addEventListener('click', insertAnswer);
$('followBtn').addEventListener('click', followUp);
$('followup').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); followUp(); }
});

loadSettings();
